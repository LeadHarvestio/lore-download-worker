# Output-ordered source instances — proposed worker update

**Review-only; not deployed or merged.** This package coordinates the application
contract with LeadHarvestio/lore-download-worker. Live support remains gated by
`capabilities.sourceInstances === 2`; existing `sourceEdit: 1` is not sufficient.
No paid jobs or saved clips are processed automatically.

The prepared worker branch includes the still-unmerged affine/rotation update
(worker PR #38). The source-instance modules were regenerated against that branch
to preserve rotation and independent axis sizing rather than overwrite them.
Merging/deploying this combined update requires separate creator approval.

## Contract

- Missing `version` retains the strict legacy, source-ordered `segments` payload.
- `version: 2` requires each segment to have a unique stable `instanceId` and an
  explicit `outputStart`. The array is ordered by output position and cannot
  overlap. Input ranges may repeat or appear in any order.
- Duration is the last output endpoint, including gaps. Gaps are black video and
  silent original audio; independently timed composition layers can remain visible.
- Per-instance speed, transform and punch-in settings remain independent.
- Canonical words and source-anchored layers/tracks remain in source coordinates.
  The application projects words and timed layer copies to each output occurrence
  before submitting output-time captions and style overrides. The worker must
  not project those captions again.
- Every endpoint shares the continuous clock; cumulative frame/sample rounding
  occurs only while encoding, never in authored captions.

## Files and bounded rendering

`render/source-edit.js` and `render/source-timing.js` are generated from the shared
application contracts. Other files are scoped replacements of the assembled
worker modules, generated with drift-checked transformations:

- `video-processor.js`: caption normalization uses the full output clock,
  including gaps and repeated shots.
- `render/process.js`: version/instance timing enters the intermediate cache key,
  in a new namespace; the logical duration survives probing.
- `render/segment-framing.js`, `render/director-layout.js`, and
  `render/stacked-creative.js`: transforms, punches, foreground masks and preview
  geometry use explicit output positions, including absence of footage in gaps.
- `server.js`: adds the new capability without changing legacy capabilities.

V2 media is encoded one shot at a time with two encoder threads. Video is joined
without re-encoding; intermediate audio is PCM and AAC is encoded only once,
avoiding cumulative per-shot codec padding. Intermediate files are removed on
success, failure and cancellation. No render deadline, concurrency, 40-segment,
30-minute, overlay/effect, or tracking-point limit is raised. Legacy media retains
the independently joined cumulative source-cut clock.

## Reproduce and prepare for review

From the app checkout:

```sh
node scripts/sync-worker-source-instances.mjs /path/to/assembled-worker
node --import tsx scripts/source-instances-native-acceptance.mjs /path/to/assembled-worker
node --loader ./scripts/source-instances-loader.mjs --test --test-concurrency=1 \
  /path/to/assembled-worker/render/source-edit.test.js \
  /path/to/assembled-worker/render/source-edit-clock.test.js \
  /path/to/assembled-worker/render/source-edit-http.test.js
```

The loader substitutes this proposal in memory only. Verification uses a random
local bearer token, unauthenticated rejection, the actual HTTP render queue,
projected caption timestamps, decoded 1080×1920 video and decoded audio. It also
checks the application's prepared playback media, fractional/subframe cuts,
silent inputs and independent placement of repeated shots.

For verification of files actually copied into an assembled worker, rather than
loader substitutions, append `--assembled` to the native acceptance command.
The prepared combined checkout passed this mode at 1080×1920, including decoded
shot order, repeated-shot placement, source audio, and black/silent gaps. Legacy
source-cut HTTP/clock tests and the affine HTTP contract also passed.

**After approval**, regenerate against the current worker branch; resolve any
reported drift rather than overwriting a newer transform contract. Copy the two
generated source modules and the transformed worker modules into that branch,
run the same acceptance against the checkout without the loader, and open a
separate worker PR. Do not deploy, enable the capability in an older worker, or
change production plans without the creator's approval.
