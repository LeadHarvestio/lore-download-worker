# Split-screen source panes and creator-selected name tags

This is an **unreleased worker update**, not an app-only feature toggle. Do not
enable the controls by mocking capabilities or merging directly into a deployed
branch. No production deployment is authorized by this change.

## Apply to the active worker

Based on `LeadHarvestio/lore-download-worker` main
`76f5a69ea416e45be04c261eabcb16285a578f07`. Files here mirror worker paths.
Copy them into a complete worker checkout (excluding this README). The active
chain is `server.js → video-processor.js → render/process.js`, with
`render/segment-framing.js` and `render/stacked-creative.js` retained in that path.
These are not replacements for an unused legacy renderer.

When rebasing, preserve other changes in the worker; use a normal three-way
merge, not a blind full-file overwrite of a newer main. The app copy is provided
for review/recovery; the worker PR is the separately deployable implementation.

## Contracts

- `sourcePanes` uses the existing topPct/top/bottom schema. Each pane crops the
  original source, honors saved manual settings or its explicit cached track,
  and clips its foreground to its own viewport. Per-cut transforms override
  tracking exactly as the editor does.
- `nameTags` uses the existing creator text, color, ID, output interval and cached
  selected face. Rendering requires `selectedFace`, an enabled explicit face ID,
  and a matching confident cached detection. It never maps a voice to a face.
- All native inputs are already in output time. The app projects canonical
  source-time edits once. The worker applies source cuts/speeds to the media but
  does **not** re-project tracks or label intervals.
- Name tags are limited to four and three output seconds each (the same 1ms
  tolerance as the app). Missing/stale, low-confidence, cropped-out and offscreen
  anchors hide the tag. Its end is exclusive.
- Below-video layers sit above each blurred pane background and below the union
  of both sharp foreground rectangles. Above-video layers and effects precede
  name labels; headlines and captions remain above labels.
- Name text is drawn into transparent PNGs, never interpolated into FFmpeg/ASS.
  No model, paid provider, analysis, automatic export, or network asset is used
  for labels.
- Background cache identity includes pane settings and a new framing namespace.
  A changed split/face track cannot reuse a single-pane background.
- Existing gates in `server/clip-styles.ts` remain intact. Only the tested new
  worker advertises `sourcePanes: 1` and `trackedNameTags: 1`. Do not advertise
  zoom/flash/punch-in capabilities as part of this update.

## Verification

From a complete worker checkout with its normal fonts/dependencies and FFmpeg:

```sh
node --test --test-concurrency=1 render/director-layout.test.js render/director-layout-http.test.js
```

These use local synthetic fixtures, including native decoded MP4 pixels,
1080x1920 output, native PNG previews, portrait/landscape, fill/blurfit, crop,
selected face tracking, per-cut transforms, cuts/speeds, lower/upper layers,
label start/end and authenticated queue/preview/thumbnail routes.
No saved user clips or paid analysis are used.

The app's shared geometry and motion schema copies are generated, not hand
maintained. Regenerate from the app root after shared contract changes:

```sh
node scripts/sync-worker-director-contracts.mjs
```

The additional source-bound visibility check in `shared/director-geometry.ts`
must reach the app too: otherwise an old preview may point into blur margins
when the face anchor has been cropped away.

Only after explicit deployment approval: merge the worker update, deploy it,
check its authenticated catalog, and verify one creator-approved sample before
announcing live availability. The development checks do not assert the live
Railway worker has changed.
