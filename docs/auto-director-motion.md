# Auto-Director native motion

This branch preserves the pending headline-visibility work. It must not be
merged or deployed to Railway without the creator's approval.

Release the compatible app first. This worker advertises version 1 flags
`flashBlend`, `zoomEffect`, `sourcePanes`, `trackedNameTags`, `segmentPunchIn`.
The app validates and edits these fields and gates unsupported recipes before
saving or rendering. Existing absent-field defaults and single-plane render
paths remain unchanged.

Contracts:

- Flash `blend`: normal/screen/overlay/multiply. Optional fractional
  attack/hold/decay envelope sums to one. Normal blend compensates for FFmpeg's
  inverse A-opacity convention. Animated values use per-frame commands.
- Zoom: scales 1–1.5, normalized anchor, linear/easeOut/easeInOut.
  Up-to-250ms rise, hold, reset at half-open end. Only sharp foreground grows.
- Source segment `punchScale`: 1–1.15, independent of placement transforms and
  compatible with selected face tracking.
- `sourcePanes`: top 40–65%; top/bottom independently fill/blurfit with optional
  saved face tracks. Timed native geometry and under-video masks match.
- `nameTags`: max four, explicit text/face ID, max three output seconds each,
  tracking text/arrow hidden for stale/offscreen detections.
- Timing and tracks must already be projected into output time by the app.
  Do not perform face analysis/transcription/provider requests to render them.

The shared geometry bundle is built from the app's shared/director-geometry.ts:
`esbuild --bundle --platform=node --format=esm --external:zod`.
Regenerate that bundle whenever its app source changes.

Verification in the compatible app workspace:

```sh
node scripts/auto-director-native-acceptance.mjs .local/auto-director-worker
node scripts/auto-director-browser-acceptance.cjs
```

These run the actual authenticated worker queue with synthetic local media at
1080×1920/30fps, without paid services or production jobs. Flash/zoom exports
took ~4.5–5s for 3s source; tracked panes/tags/cuts ~6.5–7s for 2.8s output.
Native preview/decoded export SSIM over the upper video area was 0.93–0.95.

Focused worker checks:

```sh
node --test --test-concurrency=1 render/director-motion.test.js \
  render/creative.test.js render/flicker.test.js render/source-edit.test.js \
  render/editor-refinement.test.js render/headline-visibility.test.js \
  render/source-edit-http.test.js render/tracking-smoothness.test.js \
  render/tracking-speed.test.js
```

Two older editor-placement assertions fail identically on the unmodified
headline-pending base: 432px vs full-width cover raster and 4K vs intentional
1080p output. Those unrelated stale assertions are unchanged here.

Real finished-clip visual/production-throughput evaluation remains a separate
rollout gate. Local synthetic success does not authorize a deployment.
