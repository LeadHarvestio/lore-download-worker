# Additive timeline source editing rollout

1. Publish the app first, including its optional editor-state database column.
   The timeline can edit existing overlays, captions, effects, SFX and music on
   the old worker. Source cut/speed controls remain disabled until capability 1.
2. Wait for BOTH worker download jobs and render jobs to be idle.
3. Only after owner approval, merge this PR and let Railway deploy `main`.
4. Verify authenticated `GET /api/styles` returns `capabilities.sourceEdit: 1`.
   Output must remain 1080 × 1920 at 30fps.
5. Reload the editor. Test one cached-transcript clip with two kept source
   segments and a 2× segment. Verify output duration, caption placement, sound
   synchronization, music/SFX and source muting. No new transcription is needed.
6. Legacy clients must omit `sourceEdit`; their existing behavior is unchanged.

`POST /api/process` accepts optional TOP-LEVEL `sourceEdit` with 1–40 ordered,
non-overlapping `{srcStart,srcEnd,speed?}` segments. Speeds default to 1 and are
limited to 0.25–4. Boundaries are checked against actual ffprobe source duration
before enqueueing (invalid input returns HTTP 400), and output is limited to
30 minutes. App sends output-time caption words, while preserving source-time
words in its cache. The worker never re-transcribes source-edited jobs.

Source footage/audio are trimmed and speed-adjusted together, concatenated
before the existing spatial layout, headline, caption, creative and audio stack.
Intermediate edited footage is cached by original file identity + sourceEdit.
The existing background and voice caches share that identity without being
invalidated by cache-file access-time updates.

Audio fades and custom source-volume controls are not part of this contract.
Do not enable unsupported UI controls for them.
