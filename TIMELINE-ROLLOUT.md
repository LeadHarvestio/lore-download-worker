# Timeline rendering update

Publish the compatible app before deploying this worker. This update does not merge
the separate draft native source-cuts branch and does not start analysis or rendering
automatically.

## Capabilities

- `temporalEditing: 1`: optional headline start times and music playback windows.
  Existing payloads without these fields retain their previous behavior.
- `faceTracking: 1`: reported only with `ENABLE_FACE_TRACKING=1`, an API key, and
  the installed YuNet model. The flag is deliberately off by default.
- Headline cover fitting preserves the selected preset's fonts, colors, outline,
  shadow, glow, rounded box and opacity. Transparent/unboxed looks cannot guarantee
  coverage of the source text; the app warns about this.

## Face tracking activation checklist

1. Deploy while the worker is idle. Docker installs the CPU detector and verifies
   the pinned 232,589-byte model's SHA-256 and detector initialization.
2. Keep `ENABLE_FACE_TRACKING` unset during the initial deployment.
3. On a staging/idle worker, enable the flag and analyze a real 35-second 1080p clip.
   The acceptance target is **at most 30 seconds**. This has **not** been measured on
   Railway yet and must not be advertised as verified.
4. Check one-face, multiple-face, face-loss, no-face, crop/fill and blurfit cases.
   Confirm foreground-only movement, unchanged audio, no exposed edges, and
   smooth camera movement in an actual finished MP4.
5. Disable the flag again if performance or visual checks fail. Manual framing
   remains available.

Analysis uses one CPU worker, waits behind active renders, reuses a bounded disk
cache, and only runs from an explicit authenticated request. Re-analysis can bypass
a completed cache entry with `force: true`; it does not duplicate an active job.
The model detects bounding boxes, not personal identities.

## Detector choice and remaining measurement

YuNet was selected for its small CPU model, OpenCV integration, and MIT model
license. Its model is downloaded from the pinned OpenCV Zoo 2023 model.
MediaPipe Face Detector is another CPU option, but a side-by-side accuracy and
runtime comparison on this Railway instance is **not yet complete**. Do not infer
runtime from model download size. The model's license is available at:
https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/LICENSE

Local verification covers schema limits, dead zones, smoothing and face-loss
recovery, 600-point expression construction, real FFmpeg 1080×1920/30fps framing,
20 headline-cover fixtures and an encoded/decoded cover MP4. Local synthetic
camera tracks are not evidence of real detector accuracy or Railway throughput.
