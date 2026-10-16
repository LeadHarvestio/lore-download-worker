# Face-association candidate — NOT RELEASE READY

This is an isolated worker experiment, not enabled speaker-follow and not a
production face-tracker replacement. The release source of truth will be the
draft worker pull request. No saved edit, production row, final render,
transcription, merge, Railway configuration or deployment was changed.

## Result: identity gate NOT PASSED

Three approaches were evaluated: global motion/color matching; local optical
flow plus color; and local flow plus original-resolution SFace appearance.
Color-only tracking improved the two previously reviewed car gaps, but still
fragmented IDs in the multi-person argument. The stronger model did not solve
the release blocker: reviewed car intervals still fragment, and the argument
source exceeds the existing 55-second active budget. Do not raise that timeout
or enable speaker-follow and call the gate passed.

Latest reproducible full-source benchmark (local CPU, one thread, sequential):

| Source | Duration | Analysis | Child peak RSS | Dense evidence | Result |
|---|---:|---:|---:|---|---|
| car-parking | 104.30s | 29.895s | 202,896 KiB | 1,043 frames, 10 fps, max gap 0.1s | Completed; identity gate not passed |
| car-incident | 34.17s | 19.177s | 196,128 KiB | 342 frames, 10 fps, max gap 0.1s | Completed; identity gate not passed |
| two-person-argument | 57.57s | stopped at 55s | 197,736 KiB | No partial result accepted | Budget failure |

Numbers describe this development CPU, **not** a Railway performance guarantee.
Full-clip identity-switch counts remain **unknown**, not zero. Source-specific
human continuity annotations and real-footage 1.5-second occlusion coverage
remain incomplete. Synthetic crossings and a 1.5-second missing-detection
interval passing unit tests do not substitute for those.

Known latest-candidate fragmentation in the already reviewed same-person
intervals:

- car-parking: `face-v2-16` at 78.9s, `face-v2-15` at 79.0s,
  `face-v2-19` at 79.3s. The track is not continuous.
- car-incident: the foreground seated participant is `face-v2-31` at 21.8s,
  then `face-v2-37` at 22.0s and `face-v2-33` at 22.1s.
- No current full result exists for the argument source; earlier failed
  candidates are not substituted as evidence that the latest one passes.

## Worker file mapping

The files under `render/` are the candidate source, kept here for audit and
future work. In the worker branch:

- Map `render/analyze-faces.py` here to **`render/analyze-faces-candidate.py`**.
  Keep the existing `render/analyze-faces.py` unchanged.
- Add `render/identity_tracker.py` and `render/identity_tracker_test.py`.
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
`identityVerified: false`.

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

```sh
.pythonlibs/bin/python -m unittest discover \
  -s worker-updates/face-identity/render -p '*_test.py' -v
node --test worker-updates/face-identity/face-analysis.test.mjs
.pythonlibs/bin/python scripts/face-identity-candidate-benchmark.py \
  --detector generated-artifacts/face-identity-v2/yunet.onnx \
  --appearance generated-artifacts/face-identity-v2/sface.onnx
```

The benchmark intentionally exits nonzero if any source fails. Its JSON leaves
unreviewed identity counts null. It does not claim success based on numeric IDs
or contact sheets.

App regression verification: eight relevant suites / 61 tests pass; TypeScript
check passes. Candidate tests: 7 tracker tests and 5 queue tests pass.
`scripts/face-candidate-render-check.ts` separately checks strict point/schema,
browser/native smoothing and geometry parity and decodes short 1080p/30fps
synthetic MP4s in blur-fit and fill after source cuts. That is render-contract
verification, not signed-in UI verification or participant-identity proof.

## Before rollout

1. Resolve tiny/moving face fragmentation and the multi-person CPU budget
   without relaxing identity assertions or sacrificing the 10 fps evidence.
2. Complete reviewed participant ground truth, crossings, scene boundaries and
   real/controlled 1.5-second occlusion cases on all three clips. Swaps,
   fragmentation and detector misses must be counted separately.
3. Validate resource limits on the target Railway hardware and the assembled
   authenticated analysis queue. A local mocked queue is not that proof.
4. Only after these pass, request separate merge/deployment approval, publish
   any compatible app changes first and wait for **all** worker workloads,
   including face analysis, to become idle.
5. Speaker-follow remains separate: diarization, mouth evidence, voice-to-face
   confidence, off-camera handling and camera hysteresis are not implemented.
