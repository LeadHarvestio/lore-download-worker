# Creative editing update

Deploy the compatible Replit app before merging/deploying this worker update.
No transcription, download, queue, crop, zoom, music or original-audio behavior is replaced.
Final output remains 1080 x 1920.

## Captions

Six upright Integral CF weights are available; Extra Bold is the new default.
The supplied files are Fontspring demo-labelled files, used at the owner's
explicit request. This change does not assert a commercial font license.
Existing explicit font/style overrides still win.

The reference mode uses fast nonuniform scale/blur entry and exit, heavy
uppercase type, soft halo, progressive word reveal, optional stacked lines,
and per-word color/break metadata. The original word spelling and timestamps
remain reusable. Literal censorship asterisks are preserved.
Reference mode is based on the supplied CapCut example; exact pixel identity
with CapCut's proprietary blur implementation is not asserted.

## Context and effects

Timed PNG cutouts use alpha-silhouette edges and a separate soft halo.
Timed MP4s support overlay, split-top and split-bottom. Context footage is silent;
the existing original-audio and separate music controls remain authoritative.
Splits use the sharp original source, not a compressed copy of its blurred backdrop.
Source edge crop/zoom remain respected in blurfit; fill still ignores those controls.
Fade/pop entrances, timed color flashes and subtle shakes are supported.
Shake events share one overscan pass rather than one expensive scale per event.
Headlines/captions are composited after effects and remain readable.

Assets are immutable files from canonical Replit editing-asset routes. The
downloader checks each redirect and rejects private-network destinations.
Existing cached framing/audio continue to be reused for re-edits.
Archived library entries remain usable by saved cuts.

Capabilities: advancedEditing:1, captionReference:1.
The compatible app blocks unsupported requests instead of silently dropping them.

Verified locally with native FFmpeg: timed overlays, half-frame splits,
flashes/shakes, alpha edges, preserved original audio, font/caption metadata,
existing source framing and cached re-edit regression tests.
