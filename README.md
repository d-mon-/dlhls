# DLHLS (with node)

Small script to download m3u8 stream via CLI

- Allow to restart from the last progress
- use file stream or fetch
- concurrent calls
  = more

## Setup

- `brew install ffmpeg`
- `npm install`
- `npm run pack`
- `npm install -g dlhls-1.0.0.tgz`

## Run

- `npm run local`

  or

- when installed globally: `dlhls --stream --name <output name> --url <url to .m3u8>`

## TODO

- Display progress in MB for files
- store partial progress of streamed file to start from last byte downloaded
- concurrent request on single file (stream) using Range intervals
- setup proxies
