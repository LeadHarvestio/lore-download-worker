# Source trim and thumbnail rollout

## Publish order
1. Publish the updated app first. Its source trim/split/speed controls remain
   disabled until the worker actually advertises sourceEdit: 1.
2. After publishing is verified and the download/render/face queues are idle,
   merge this combined worker update and deploy its commit on Railway.
   It integrates the earlier timeline and style-preserving headline-cover
   drafts; do not separately merge stale copies of those overlapping changes.
3. Keep the existing worker API_KEY configured. Thumbnail extraction and
   retention require authentication even on otherwise legacy workers.
4. Refresh worker support in app Settings. Check sourceEdit: 1, thumbnails: 1,
   temporalEditing: 1 and headlineCoverStyle: 1 in the authenticated /api/styles.
5. Try one short clip before batching. Save is not Render; no paid transcription
   or final encode starts just because the timeline or thumbnail picker opens.

## Face tracking
The CPU analysis implementation and model provisioning are included, but its
production activation remains deliberately gated. Benchmark an actual 30–60s
clip on the deployed worker first; do not infer readiness from a mock test.
After that benchmark is accepted, set ENABLE_FACE_TRACKING=1 using the worker's
environment settings and redeploy. API_KEY must exist and FACE_MODEL_PATH must
point to the provisioned YuNet model (default /app/render/yunet.onnx).
Only then does faceTracking: 1 appear. Without activation it reports 0 and the
analysis endpoint returns an explicit 503. Face analysis waits for renders.

## Trim contract
Optional top-level sourceEdit contains 1–40 sorted non-overlapping segments
{srcStart,srcEnd,speed}; speed defaults to 1 and is restricted to 0.25–4.
Bounds are checked against the downloaded source; output is 1s–30min.
Edited requests require saved output-time words, including [] for silent clips.
The worker never silently re-transcribes a source edit. Legacy requests omit
sourceEdit and retain the existing untrimmed path.

The app keeps source-authored values canonical. A right/left trim projects
captions, context layers, effects, SFX, music windows, markers, face paths and
headline visibility. Original audio and censorship use the edited source.
Subscribe animations anchor to the new output end. Leading music trim advances
the song offset. Undo/re-extension restores hidden items; saving visible edits
does not discard authored tails.

Source encoding uses trim/setpts, atrim/asetpts, chained atempo and concat.
Its cache key includes the original file fingerprint and normalized segments.

## Thumbnails and retention
POST /api/thumbnail is an authenticated, two-slot light queue with strict
filename/time/crop/format validation, in-flight deduplication and a bounded
12MiB frame cache. Crops: 1080x1920, 1080x1080 and 1280x720; JPG must stay <2MiB.
POST /api/thumbnail/hold accepts {filename,pending}; THUMBNAIL_KEEP_HOURS defaults
to 24 and is bounded to 4–72 hours. Selection/Skip releases the hold.
The app immediately stores a 25%-time default from its saved FINAL MP4 on
approval, so worker cleanup/restarts cannot remove the only thumbnail.
Chosen images and metadata use App Storage and the existing editor-state field.
Older workers use the explicitly labelled browser-canvas picker fallback.

## Verification
Run node --test --test-concurrency=1 render/source-edit.test.js
render/source-edit-http.test.js render/thumbnails.test.js
render/headline-cover-fit.test.js after installing the worker dependencies.
These execute real FFmpeg trim/concat/speed/audio tests, an authenticated worker
HTTP render queue, accurate selected-frame comparison and crop/size checks.
The app's tests cover projection/restoration, untrimmed identity and durable
default saving. Browser fixtures cover desktop/touch picker and preview sizing.
Native iOS sharing and actual production face performance remain unverified.
