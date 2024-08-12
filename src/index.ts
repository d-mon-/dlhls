#!/usr/bin/env node

import Bluebird from "bluebird";
import cliProgress, { SingleBar } from "cli-progress";
import { program } from "commander";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs-extra";
import os from "os";
import assert from "assert";
import path from "path";
import axios from "axios";
import { Blob, Buffer } from "buffer";

var m3u8Parser = require("m3u8-parser");
var parser = new m3u8Parser.Parser();

function sleep(value: number): Promise<void> {
  return value > 0
    ? new Promise((res) => setTimeout(() => res(), value))
    : Promise.resolve();
}

class DLHLS {
  private baseUrl: string;
  private tmpPath: string;
  private filename: string;
  private multibar = new cliProgress.MultiBar(
    {
      clearOnComplete: false,
      hideCursor: true,
      format: " {bar} | {filename} | {value}/{total}",
    },
    cliProgress.Presets.shades_grey
  );

  constructor(
    private url: string,
    private name: string,
    private rate: number,
    private enableStream: boolean,
    private concurrency: number
  ) {
    const splitIndex = url.lastIndexOf("/") + 1;
    this.baseUrl = url.substring(0, splitIndex);
    this.filename = url.substring(splitIndex);
    this.tmpPath = path.join(os.tmpdir(), "dlhls", this.name);
  }

  async execute() {
    fs.ensureDirSync(this.tmpPath);
    const manifest = await this.getManifest.bind(this)();
    const segments = manifest.segments.map((v: any) => v.uri);
    await this.downloadTsFiles.bind(this)(segments);
    await this.convertFfmpeg.bind(this)();
    fs.removeSync(this.tmpPath);
  }

  async downloadAndSave(url: string, filename: string) {
    const blob = this.enableStream
      ? await this.streamFile.bind(this)(url, filename)
      : await fetch(url).then((r) => r.blob());

    fs.writeFileSync(
      path.join(this.tmpPath, filename),
      Buffer.from(await blob.arrayBuffer())
    );
    return blob;
  }

  async streamFile(url: string, filename: string) {
    let result = new Blob([]);
    let fileProgress: SingleBar | undefined;
    let usePercent = false;

    const request = async () => {
      let chuncks: Buffer[] = [];

      async function saveChunks() {
        result = new Blob([await result.arrayBuffer(), ...chuncks]);
      }

      try {
        const response = await axios(url, {
          headers: {
            Connection: "keep-alive",
            "Accept-Encoding": "gzip, deflate",
            Range: `bytes=${result.size}-`,
          },
          responseType: "stream",
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        });

        if (!fileProgress) {
          let contentLength =
            response.headers["Content-Length"] ||
            response.headers["content-length"];
          if (!contentLength) {
            usePercent = true;
            contentLength = 100;
          }
          fileProgress = this.multibar.create(Number(contentLength), 0, {
            filename,
          });
        }

        for await (const chunk of response.data) {
          if (!usePercent) {
            fileProgress.increment(Buffer.byteLength(chunk));
          }
          chuncks.push(chunk);
        }
        await saveChunks();
      } catch (err) {
        await saveChunks();
        sleep(1000);
        await request();
      }
    };

    await request();

    if (fileProgress) {
      this.multibar.remove(fileProgress);
    }

    return result;
  }

  async getManifest() {
    const m3u8Path = path.join(this.tmpPath, this.filename);
    const result: string = fs.existsSync(m3u8Path)
      ? fs.readFileSync(m3u8Path).toString()
      : await this.downloadAndSave(this.url, this.filename).then((r) =>
          r.text()
        );

    parser.push(result);
    parser.end();
    return parser.manifest;
  }

  async convertFfmpeg() {
    const inputFile = path.join(this.tmpPath, this.filename);
    const outputDir = process.cwd();
    const ouputPath = path.join(outputDir, this.name + ".mp4");

    const convertingProgress = this.multibar.create(100, 0, {
      filename: "converting",
    });
    return await new Promise<void>((res, rej) => {
      ffmpeg(inputFile)
        .videoCodec("copy")
        .audioCodec("copy")
        .on("error", (err) => {
          convertingProgress.stop();
          console.log("An error occurred: " + err.message);
          rej(err);
        })
        .on("progress", (progress) => {
          convertingProgress.update(Math.floor(progress.percent ?? 0) as any);
        })
        .on("end", async () => {
          convertingProgress.update(100);
          await sleep(100);
          console.log("\nDone! Go to: ", ouputPath);
          res();
        })
        .save(ouputPath);
    });
  }

  async downloadSingleSegment(segment: string) {
    try {
      await this.downloadAndSave.bind(this)(this.baseUrl + segment, segment);
      await sleep(this.rate);
    } catch (err) {
      // console.log(err, segment);
      await sleep(Math.min((this.rate + 1000) * 5, 30_000)); // wait between 5 and 30 seconds in case of error
      await this.downloadSingleSegment.bind(this)(segment);
    }
  }

  async downloadTsFiles(segments: string[]) {
    const savedSegments = new Set(fs.readdirSync(this.tmpPath));
    const segmentsToDl = segments.filter((seg) => !savedSegments.has(seg));
    const diff = segments.length - segmentsToDl.length;

    const totalProgress = this.multibar.create(segments.length, diff, {
      filename: "total",
    });
    await Bluebird.map(
      segmentsToDl,
      async (segment: string) => {
        await this.downloadSingleSegment(segment);
        totalProgress.increment();
      },
      {
        concurrency: this.concurrency,
      }
    );
    this.multibar.remove(totalProgress);
  }
}

program.name("dlhls").description("CLI to download streams").version("1.0.0");

program
  .option("--name <name>", "folder name")
  .option("--url <url>", "Url to retrieve m3u8 from")
  .option("--stream")
  .option("--rate <number>", "rate limit in milliseconds (default: 0)")
  .option(
    "--concurrency <number>",
    "number of concurrent queries (default: 12)"
  );

program.parse(process.argv);

const options = program.opts();

(async () => {
  assert.ok(options.url, "Url is required");
  assert.ok(options.name, "Name is required");

  const rate = Number(options.rate);
  const concurrency = Number(options.concurrency);

  const dlhls = new DLHLS(
    options.url,
    options.name,
    rate > 0 ? Math.floor(rate) : 0,
    options.stream,
    concurrency >= 1 ? Math.floor(concurrency) : 12
  );

  await dlhls.execute();
  process.exit();
})();
