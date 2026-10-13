# Face tracking readiness

Tracking remains disabled until a real source has passed validation on the
deployed worker. This change does not turn it on or alter exports.

After the worker is idle and this update is approved/deployed:

1. Select one representative 30–60 second source with a visible face and confirm
   the original worker input exists (restore the original if necessary; do not
   substitute a finished censored/music-mixed cut).
2. Send the authenticated POST /api/analyze/faces with clipFilename,
   benchmark: true, force: true. The existing one-slot analysis queue still waits
   for renders, and the existing 60-second active-time budget remains enforced.
   No paid transcription or third-party face API is called.
3. Poll the authenticated job endpoint. Require a successful result, at least
   one sensible face track, analysisSeconds below the active budget, and smooth
   crop behavior in browser and decoded output. A cached result is not evidence
   of deployed performance; force a fresh analysis.
4. Only after that check passes, set ENABLE_FACE_TRACKING=1 through Railway's
   environment settings and redeploy when all queues are idle. Verify the
   published app reports faceTracking: 1. Keep it off if validation fails.

benchmark: true bypasses only the activation switch for that authenticated
analysis request. It does not change the advertised capability or persist a
tracking setting to a clip. Ordinary requests remain gated as before.
