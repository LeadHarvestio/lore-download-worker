# Output quality

## Source editing

The styles catalog advertises `capabilities.sourceEditing: 1`. Presets expose
`source: { cropLeftPct, cropRightPct, cropTopPct, cropBottomPct, zoom, muteAudio }`.
Each edge crop defaults to 0% and accepts 0–40%; zoom defaults to 1 and accepts
1–3; original audio defaults to unmuted. Inputs are validated.

In blurfit, crop trims the source before splitting into blurred and sharp copies.
Zoom enlarges only the sharp foreground and clips it at the output frame.
Automatic headline placement tracks the edited foreground bounds. Fill ignores
crop/zoom but respects original-audio muting. The same editing applies to
1080p PNG previews and 1080p finished MP4s.

Original-audio muting silences only the source's rendered voice channel, not
music or transcription. Raw source audio and cached words remain available for
unmuting/restyling. Existing finished files require an explicit re-render.

New finished cuts render at **1080 × 1920 (vertical 1080p), 30 fps**, using
browser-compatible H.264/yuv420p video and AAC audio. Lower-resolution source
footage is upscaled; no extra native source detail is recovered by upscaling.
Existing finished files keep their original resolution until re-rendered.

The synchronous style-preview PNG endpoint stays **1080 × 1920** for speed.
Headline/caption sizes, placement, padding and blur scale with frame dimensions,
so their proportions stay consistent between style previews and final renders.
The styles catalog reports these dimensions, and completed render jobs include
the actual probed output width and height.

1080p replaces the previous 4K default to reduce render CPU/memory pressure and
avoid 12-minute processing timeouts. A timeout alone does not identify the cause;
the worker must still be healthy and have capacity for queued jobs. Keep bounded
HTTP byte ranges for playback and streamed full downloads: longer 1080p videos
can still exceed a publishing proxy's response-size limits.

# lore-download-worker

Railway worker for downloading source clips and rendering review-ready vertical Shorts. All download, transcription, captioning, and FFmpeg work stays in this service.

## Runtime configuration

- `API_KEY` — optional Bearer-token authentication for the `/api/*` routes. Set it in the worker's secret/environment settings.
- `PORT` — listening port; Railway supplies this automatically.
- `DOWNLOAD_DIR` — temporary worker files, defaulting to `/tmp/downloads`.
- `WHISPER_MODEL` — faster-whisper model name, defaulting to `base`.
- `MAX_CONCURRENT_RENDERS` — simultaneous renders, defaulting to `1`.

The Docker image installs FFmpeg, fontconfig, the bundled Anton / Archivo Black / Bebas Neue fonts, yt-dlp, and faster-whisper. Whisper downloads its selected model the first time it is used.

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

`musicUrl` may be `null`. The worker validates the source video, transcribes it with word timestamps (faster-whisper), renders a 1080×1920 MP4 with a styled headline and word-by-word captions, and mixes optional music below the source audio.

### Style fields (all optional — old requests still work)

```json
{
  "stylePresetId": "boxed_red",
  "styleOverrides": { "headline": { "yPct": 30 }, "caption": { "highlightColor": "#FFE600" } },
  "words": [{ "word": "these", "start": 0.3, "end": 0.7 }],
  "musicVolumeDb": -15
}
```

- `stylePresetId` — `boxed_red` (default), `glow_magenta`, or `cyan_pop`. See `render/styles.js` for every setting (fonts, sizes, colors, box, stroke, shadow, glow, positions, words per caption chunk).
- `styleOverrides` — nested object deep-merged over the preset.
- `words` — cached word timestamps from a previous render. When present, Whisper is skipped, so restyling is fast.
- `musicVolumeDb` — −30 to −5, default −15.
- Use a **new `jobId` for every render**. Re-sending a completed `jobId` returns the old result without re-rendering.
- A `404` from `POST /api/process` means the downloaded clip is no longer on the worker (kept 24 h); re-download it and retry.
- `highlightWords` entries may be single words or multi-word phrases.

- `GET /api/process/status/:jobId` returns `processing`, `completed`, or `failed`.
- Completed jobs include `filename`, `downloadUrl`, `words` (the word timestamps used — store them to restyle without re-transcribing), and `srtPath` when word captions are available. Fetch the MP4 and optional SRT through `GET /api/file/:filename`.
- Failed jobs include an `error` string so the app can offer a retry.

Health checks use unauthenticated `GET /health`. Debug, download, render, status, and file routes retain Bearer-token protection whenever `API_KEY` is set.

## Style API

- `GET /api/styles` returns `{ presets, fonts }`; build the style editor from it.
- `POST /api/preview` returns a PNG of one frame. Body: `{ stylePresetId, styleOverrides, headline, highlightWords, words?, clipFilename?, at? }`. Omit `clipFilename` for a blank background. Typically 1–3 s.

## Adding a font

Drop a `.ttf` in `fonts/`, add it to `FONTS` in `render/styles.js` (`family` must be the font's internal family name), redeploy.

## Local checks

Run `npm test` to exercise the authenticated download-to-render flow against a generated local video, validate the optional music mix, and confirm failed jobs return useful status. Tests use a temporary transcription stub and clean up their generated files; they do not contact external clip or music services.

## Download batches

`POST /api/download` accepts the entire batch. Downloads use a FIFO queue with two active jobs; a failed job releases its slot and the remaining jobs continue automatically. `GET /api/status/:jobId` reports `queued` and `queuePosition` while waiting, then `downloading`, `completed`, or `failed`. Clients must not count queue waiting toward their active-download timeout. Publish the compatible app before merging this worker change.

TikTok share links are resolved only through approved HTTPS TikTok hosts and normalized to full `www.tiktok.com/@creator/video/id` URLs. The build refreshes yt-dlp after source changes to avoid an old cached extractor. TikTok restrictions can still prevent downloads; errors remain visible rather than being replaced by a directory listing. Downloader and conversion failures are not treated as successful partial files.