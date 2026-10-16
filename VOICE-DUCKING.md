# Opt-in sound-effect speech ducking

`GET /api/styles` advertises `voiceDucking: 1` for this tested update.
No deployment is included or approved by this change.

Only a `styleOverrides.soundEffects[]` item with `voiceDucking` is attenuated.
Original voice, music, other sounds, existing music fades and final loudness
settings are unchanged. An absent option preserves ordinary sound playback.
The app lets the creator enable or remove the option per saved sound.

The strict option matches the app's `shared/auto-director.ts` schema:
- `attenuationDb`: -12 to -3
- `attackMs`: integer 10 to 100
- `releaseMs`: integer 50 to 500
- `durationSeconds`: 0.1 to 1, minimum hold from word start
- `leadSeconds`: 0 to 0.1, full attenuation this far before speech

Attack begins `attackMs` before that lead; hold protects the complete spoken
word, even when longer than `durationSeconds`, then release restores unity.
Overlapping word windows use the strongest envelope, not multiplied gains.
Each overlapping sound has an independent opt-in envelope.

The existing `words` request is OUTPUT time. The app retains canonical source
words for undo and projects the export copy once through all cuts/speeds.
This worker must not project these words or sound placements again. Ducking
requires a provided saved word array (`[]` explicitly means no speech); omitting
it fails before any transcription. No new transcription, analysis, or paid
provider call is made. Raw normalized words drive audio, before caption masking.
Blank and square-bracketed nonspoken placeholders do not trigger ducking.

Sound trim bounds are checked against the saved asset metadata AND ffprobe's
actual audio duration (50ms codec tolerance). Source cuts cannot expand the
sound's playable audio. Sound volume, trim, delay and mute remain independent.
After delay, timestamp reconstruction prevents FFmpeg 6 from collapsing
leading silence; ducking then uses 10ms frames on the output clock.

## Verification

Run heavy render tests serially:

```
node --test --test-concurrency=1 render/voice-ducking.test.js render/voice-ducking-http.test.js render/sound-effects.test.js render/source-edit-http.test.js render/music-filters.test.js
```

The tests decode AAC, reconstruct timestamps, and measure speech onset/end,
attack/release, silence, unchanged ordinary gain, no-speech behavior, duplicate
speech windows and overlapping selected/unselected sounds. The authenticated
HTTP queue cuts out source pauses, preserves output word times, renders actual
1080x1920 MP4s and checks frequency-isolated source/selected/unselected levels.
It also rejects unauthorized requests and malformed ducking options.
Fixtures use isolated test authentication and app-shaped cached audio URLs.
No live credentials, network downloads, transcription or user clips are used.

Rollout: merge/deploy only after explicit approval, then confirm authenticated
live `/api/styles` and an actual app-to-worker export. The app's existing exact
capability check must stay in place until the compatible worker is deployed.
