# What changed vs. commit c29d28e ("Add clip rendering worker pipeline")

Replace/add these files in the repo (everything else is untouched):

| file | change |
|---|---|
| `video-processor.js` | Rendering rewritten. The black `drawbox` bar + DejaVu Sans ASS is gone; headline is now a rendered PNG (rounded box / glow / stroke / shadow / per-word colors), captions are ASS with fonts, active-word color, glow, pop. SSRF-safe music fetch, faster-whisper call, SRT output and probing are unchanged. New exports: `previewFrame`, `validateStyleInput`. |
| `server.js` | `/api/process` accepts optional `stylePresetId`, `styleOverrides`, `words`, `musicVolumeDb` (−30…−5). Completed jobs return `words`. New `GET /api/styles`, `POST /api/preview`. Downloaded clips kept 24 h (was 4 h). Old request bodies still work. |
| `render/` (new) | `styles.js`, `headline.js`, `captions.js`, `process.js` |
| `fonts/` (new) | Anton, Archivo Black, Bebas Neue (SIL OFL) |
| `Dockerfile` | + fontconfig, copies `render/` and `fonts/`, registers fonts |
| `package.json` | + `@napi-rs/canvas` |
| `server.test.js` | original 2 tests untouched + 1 new style/preview test |
| `README.md` | documents the new fields and endpoints |

`transcribe.py` is unchanged. `npm test`: 3/3 pass.
