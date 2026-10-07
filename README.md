# lore-download-worker

Railway worker for downloading source clips and rendering review-ready vertical Shorts. All download, transcription, captioning, and FFmpeg work stays in this service.

## Runtime configuration

- `API_KEY` — optional Bearer-token authentication for the `/api/*` routes. Set it in the worker's secret/environment settings.
- `PORT` — listening port; Railway supplies this automatically.
- `DOWNLOAD_DIR` — temporary worker files, defaulting to `/tmp/downloads`.
- `WHISPER_MODEL` — faster-whisper model name, defaulting to `base`.
- `MAX_CONCURRENT_RENDERS` — simultaneous renders, defaulting to `1`.

The Docker image installs FFmpeg, DejaVu fonts, yt-dlp, and faster-whisper. Whisper downloads its selected model the first time it is used.

## Download API

- `POST /api/download` accepts `{ assetId, sourceUrl, startTrim?, endTrim?, maxDuration? }` and returns a download `jobId`.
- `GET /api/status/:jobId` returns `downloading`, `completed`, or `failed`, with a `filename` and `downloadUrl` on success.
- `GET /api/file/:filename` serves a completed download.

## Render API

`POST /api/process` accepts the downloaded worker filename and render settings:

```json
{
  "jobId": "processed-clip-id",
  "clipFilename": "source-clip.mp4",
  "headline": "STREAMER CLIP HEADLINE",
  "highlightWords": ["STREAMER"],
  "musicUrl": "https://app.example/api/music/track-id/file",
  "captionStyle": "word-by-word",
  "musicVolumeDb": -15,
  "outputAspectRatio": "9:16"
}
```

`musicUrl` may be `null`. The worker validates the source video, transcribes it with word timestamps, renders a 1080×1920 MP4 with the headline bar and lower-third captions, and mixes optional music below the source audio.

- `GET /api/process/status/:jobId` returns `processing`, `completed`, or `failed`.
- Completed jobs include `filename`, `downloadUrl`, and `srtPath` when word captions are available. Fetch the MP4 and optional SRT through `GET /api/file/:filename`.
- Failed jobs include an `error` string so the app can offer a retry.

Health checks use unauthenticated `GET /health`. Debug, download, render, status, and file routes retain Bearer-token protection whenever `API_KEY` is set.

## Local checks

Run `npm test` to exercise the authenticated download-to-render flow against a generated local video, validate the optional music mix, and confirm failed jobs return useful status. Tests use a temporary transcription stub and clean up their generated files; they do not contact external clip or music services.