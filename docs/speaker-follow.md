# Opt-in active-speaker analysis

This candidate adds CPU-only visible-speaking analysis to the verified face-ID
tracker. It is not biometric voice identification, personal-name recognition,
or phoneme-level synchronization verification.

## Runtime and rollout

- Build the candidate with the generated worker Dockerfile. The pinned upstream
  MIT Light-ASD TalkSet weights and source files are SHA-256 checked before export.
  The build checks PyTorch/ONNX probability parity at four sequence lengths.
- PyTorch is export-only and removed in the same build layer. Serving uses
  ONNX Runtime CPU, MFCC features and the existing face tracker.
- Preserve `FACE_ANALYSIS_CANDIDATE=1` and `ENABLE_FACE_TRACKING=1`.
  `/api/styles` advertises `activeSpeaker: 1` only with the installed model and
  enabled verified tracker. Do not advertise it on an older worker.
- Ordinary face analysis stays on its existing path. Only a request with
  `speakerFollow: true` invokes this model; its cache is separate.
- Keep dense face evidence at 10 fps. The model receives actual source video
  sampled at 25 Hz. Face analysis retains its 55-second budget; neural analysis
  has a separate 180-second budget and its queue process has a 240-second timeout.
- Camera tracks remain in canonical source time. The app projects cuts once at
  preview/render boundaries. An initially absent speaker must not pull the
  camera toward a future observation.
- Analysis never changes a user recipe. “Follow speaker” or the explicit
  Auto-Director option applies the cached path through the normal undoable save.
  Mixed face IDs must not be filtered down to a single selected face.
- Cached camera paths render without requiring new face analysis to be enabled.

## Confidence and scope

Only confident visible-speaking evidence with a reliable face detection is
eligible. Silence, overlapping diarized turns and competing faces abstain.
Three consecutive wins and a minimum dwell prevent rapid target switching.
Uncertain/offscreen sections fall back to the existing held/eased manual crop.
Existing cached transcripts are sufficient; no paid diarization is automatic.

The real three-clip run produced usable sections on two clips and deliberately
abstained on the third. This is not a promise of complete coverage on arbitrary
footage. Silence and frozen-mouth controls must remain negative. Shifting an
audio track while retaining speech is not, by itself, a valid identity test:
this active-speaker classifier does not prove that particular spoken phonemes
belong to a particular visible person.

## Reproduce isolated checks

Keep all original footage, model binaries, renders and reports under the ignored
`generated-artifacts/` directory. Never modify real clip recipes for QA.

1. `node scripts/prepare-speaker-worker.mjs` assembles the checked upstream source.
2. Install `speaker-qa-requirements.txt` in the QA runtime when running inference.
   Model export additionally uses the temporary CPU-only packages documented in
   the Dockerfile; do not ship these packages in the web application's image.
3. `node scripts/active-speaker-worker-check.mjs` runs the authenticated worker
   queue on the three saved originals and checks compact face-track parity.
4. `npx tsx scripts/speaker-director-acceptance.ts` consumes the recorded paid
   analysis, checks plan application, exact undo and manual-edit preservation,
   and asserts frozen-mouth/silent abstention.
5. `npx tsx scripts/speaker-export-acceptance.ts` renders the real inferred
   mixed-ID path through two source cuts in blur-fit and fill at 1080×1920/30fps.
6. Run the existing native/browser Auto-Director acceptance scripts, TypeScript
   check and full test suite.

The paid test scripts keep exclusive claims and do not automatically retry
uncertain billing. Reuse their successful cached outputs.
