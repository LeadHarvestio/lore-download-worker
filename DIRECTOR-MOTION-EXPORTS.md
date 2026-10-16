# Auto-Director export motion

Unreleased, approval-gated addition to the source panes/name tags branch.
Do not merge or deploy without creator approval. This supersedes the motion
portion of the older broad Auto-Director PR, not the newer source-pane work.

## Additive capabilities

- `segmentPunchIn: 1`: optional `sourceEdit.segments[].punchScale` (1–1.15).
  Punch geometry shares a foreground stream; manual transforms retain their
  established tracking override. Source zoom is capped at 3×.
- `zoomEffect: 1`: foreground-only normalized anchor, 1–1.5× from/to scale,
  linear/easeOut/easeInOut, up to 250ms rise followed by hold, half-open reset.
  Last active zoom wins. The blurred background does not receive effect zoom.
- `flashBlend: 1`: normal/screen/overlay/multiply and optional fractional
  attack/hold/decay. Native blend opacity is commanded once per frame, not
  evaluated for each pixel. Fractional-frame command times floor to microseconds.

No new defaults are added to presets or legacy recipes. Legacy no-motion
framing, legacy flash drawboxes, source-edit request shape, explicit cached
transcripts, regular flicker and manual editing remain supported. New flash
blends follow creative imagery/flicker and precede labels/headlines/captions.
Native inputs are already output-time; do not project them a second time.
Trimmed manual framing passes retain their global output origin.

Sharp-plane masks and cached backgrounds include motion geometry. Independent
source-cut clock changes must preserve the additive punch validation/serialization.

## Verification

```sh
node --test --test-concurrency=1 render/director-motion.test.js \
  render/director-layout.test.js render/director-layout-http.test.js \
  render/creative.test.js render/flicker.test.js render/source-edit.test.js
```

The HTTP test launches the assembled server with a fixture-only key, asserts
anonymous rejection and malformed-motion rejection, queues real MP4s, checks
1080×1920/30fps and audio, and compares active flashes/zoom/punch frames to native
PNGs. Cached face rendering does not require analysis.

The companion app's `scripts/auto-director-native-acceptance.mjs --benchmark`
and `--active-flashes`, followed by
`scripts/auto-director-browser-acceptance.cjs`, compare the actual canvas renderer
with decoded native exports. They use local fixtures, not production queues or
paid APIs. Evidence is ignored under `generated-artifacts/auto-director/native`.

Local synthetic measurements: 36s unchanged fill took 23.27s; 27.2s, 12-cut
motion fill/blurfit took 58.09s/56.90s. Those mixed-speed recipes include six zooms,
six flashes, alternating punch-ins and three manual-placement intervals.
Worker/children peak RSS was 389 MB for baseline and 3,269/3,093 MB for the
manual-placement-heavy cuts. Ordinary 3s motion jobs used about 425–497 MB.
Separate full-resolution manual camera branches still have a substantial
memory cost; this is not a Railway capacity guarantee.

App-side capability validation remains in place until an explicitly approved
candidate worker is deployed and verified. No automatic render or paid analysis
is introduced by this change.
