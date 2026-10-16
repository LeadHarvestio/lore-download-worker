# Face-association fix — reported regressions verified

This is an isolated worker experiment, not enabled speaker-follow and not a
production face-tracker replacement. Draft worker PR:
<https://github.com/LeadHarvestio/lore-download-worker/pull/41>.
No saved edit, production row, final render,
transcription, merge, Railway configuration or deployment was changed.

## Result: reported regression checks PASS; full speaker identity gate unverified

The two reported failures are fixed in `local-motion-keyframe-v3`:

- Unreliable embeddings from tiny/blurred faces no longer override strong
  continuous visual tracking. Appearance anchors constrain reacquisition rather
  than every visible frame. Fresh observations are preferred over stale
  candidates; out-of-frame feature masks are clamped correctly.
- Dense detector/landmark evidence stays at **10 fps**. Expensive appearance
  inference uses **2 Hz keyframes**, rather than being repeated on every frame.
  Lost tracks do not repeatedly run local optical flow on stale image regions.
- The 55-second active and 60-second subprocess limits are unchanged.

Latest reproducible full-source benchmark (local CPU, one thread, sequential):

| Source | Duration | Analysis | Child peak RSS | Dense evidence | Result |
|---|---:|---:|---:|---|---|
| car-parking | 104.30s | 18.963s | 203,792 KiB | 1,043 frames, 10 fps, max gap 0.1s | Completed |
| car-incident | 34.17s | 9.196s | 195,200 KiB | 342 frames, 10 fps, max gap 0.1s | Completed |
| two-person-argument | 57.57s | 22.963s | 196,108 KiB | 576 frames, 10 fps, max gap 0.1s | Completed |

The assembled authenticated HTTP worker independently completed the three
analyses in **18.017s, 9.285s and 22.194s**, respectively. It runs the actual
Python subprocess, rejects unauthorized requests, serializes jobs, deduplicates
simultaneous force requests, saves dense sidecars and recovers the completed
results from disk after a full local worker restart.

Numbers describe this development CPU, **not** a Railway performance guarantee.
Full-clip identity-switch counts remain **unknown**, not zero. Source-specific
human continuity annotations and real-footage 1.5-second occlusion coverage
remain incomplete. Synthetic crossings and a 1.5-second missing-detection
interval passing unit tests do not substitute for those.

Manually reviewed regression intervals, checked using version-independent
participant annotations rather than assuming detector IDs are identities:

- car-parking, **78.7–79.8s**: seated participant retains one ID through rapid
  camera movement and the short missed detection.
- car-incident, **21.5–22.5s**: seated participant retains one ID across the two
  brief detection gaps.
- two-person-argument, **27.0–28.3s**: lime-vest participant retains one ID;
  foreground and tall orange-vest participants keep different IDs. The
  previously observed wrong-person transfer is absent in this interval.

All **48 manually associated observations** across five participant intervals
pass continuity and distinct-person checks. These are interval-level results,
not whole-clip zero-error totals. Annotations and evidence generation are in
`scripts/face-identity-reviewed-intervals.json` and
`scripts/face-identity-interval-check.py` in the app repository.

## Worker file mapping

The files under `render/` are the candidate source, kept here for audit and
future work. In the worker branch:

- Map `render/analyze-faces.py` here to **`render/analyze-faces-candidate.py`**.
  Keep the existing `render/analyze-faces.py` unchanged.
- Add `render/identity_tracker.py`, `render/identity_tracker_test.py` and
  `render/analyze_faces_test.py`.
- Update `render/face-analysis.js` with the isolated candidate selection.
- Map `face-analysis.test.mjs` to `face-analysis-candidate.test.mjs` in worker root.
- Install the pinned appearance model and its license in the worker image.
- Do **not** set `FACE_ANALYSIS_CANDIDATE=1` on the production worker.

The default queue executes the unchanged legacy analyzer. Candidate mode is
explicit for a staging/test instance only, uses a separate cache namespace,
keeps dense timed boxes/landmarks in a gzip sidecar, and returns only a manifest
plus <=600 camera points per track to the app. Embeddings are ephemeral local
memory: no embedding persistence, named recognition or cross-video lookup.
No speaker capability is advertised. A result explicitly states
`identityVerified: false`, because full-clip participant identity and real
1.5-second occlusion certification are not established by these regression tests.

## Bounds and recovery

- Exact global one-to-one assignment, <=8 detections and <=24 retained
  association candidates; motion prediction, local forward/backward optical
  flow, scene reset, appearance consistency and ambiguous-match rejection.
- No fabricated face observations during occlusion. Existing camera smoothing
  holds/eases back to manual framing when observations disappear.
- Candidate analysis accepts sources up to **180 seconds**, refuses sources
  below 10 fps, and never silently samples longer sources below 10 fps.
- Existing 55-second analysis / 60-second subprocess limits remain intact.
  Failure is explicit; partial dense evidence is not accepted.
- Dense results have separate retention and a cache version. Missing sidecars
  invalidate candidate cache hits, including after a queue restart.
- Manual tracking schema, smoothness/follow speed, crop geometry and the
  original app's saved recipes remain unchanged.

## Reproduce

Models:

- YuNet 2023mar SHA256:
  `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`
- OpenCV Zoo SFace `face_recognition_sface_2021dec_int8.onnx` SHA256:
  `2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a`
- SFace is Apache-2.0, supplied by OpenCV Zoo. Preserve its bundled license:
  <https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface>

Use OpenCV **4.11.0.86**, matching the worker image, not an untested major
upgrade. Keep model binaries, originals, contact sheets and MP4 test outputs
under ignored `generated-artifacts/`; never check them into either repository.
`requirements-test.txt` records the offline test dependencies. They were
removed from the main app's dependency manifest after testing so publication
does not install an unnecessary video-analysis stack. Set up that test
environment before running these commands.

```sh
.pythonlibs/bin/python -m unittest discover \
  -s worker-updates/face-identity/render -p '*_test.py' -v
node --test worker-updates/face-identity/face-analysis.test.mjs
.pythonlibs/bin/python scripts/face-identity-candidate-benchmark.py \
  --detector generated-artifacts/face-identity-v2/yunet.onnx \
  --appearance generated-artifacts/face-identity-v2/sface.onnx \
  --output generated-artifacts/face-identity-keyframe
.pythonlibs/bin/python scripts/face-identity-interval-check.py
node scripts/face-worker-queue-check.mjs
npx tsx scripts/face-candidate-render-check.ts
```

The benchmark intentionally exits nonzero if any source fails. Its JSON leaves
unreviewed identity counts null. It does not claim success based on numeric IDs
or contact sheets.

App regression verification: eight relevant suites / 61 tests pass; TypeScript
check passes. Candidate tests: 9 tracker tests, 2 analyzer cadence/limit tests
and 5 queue tests pass.
`scripts/face-candidate-render-check.ts` separately checks strict point/schema,
browser/native smoothing and geometry parity and decodes short 1080p/30fps
synthetic MP4s in blur-fit and fill after source cuts. That is render-contract
verification, not signed-in UI verification or participant-identity proof.

## Before rollout

1. Review the measured fixes and request separate merge/deployment approval.
   Default production analysis remains unchanged until candidate activation.
2. Before speaker-follow, complete reviewed participant ground truth, crossings, scene boundaries and
   real/controlled 1.5-second occlusion cases on all three clips. Swaps,
   fragmentation and detector misses must be counted separately.
3. Validate resource limits on the target Railway hardware. The real local
   authenticated queue now passes; that is not a target-hardware benchmark.
4. Deploy only after approval and when **all** worker workloads, including face
   analysis, are idle. No web-app runtime changes are required by this fix.
5. Speaker-follow remains separate: diarization, mouth evidence, voice-to-face
   confidence, off-camera handling and camera hysteresis are not implemented.
