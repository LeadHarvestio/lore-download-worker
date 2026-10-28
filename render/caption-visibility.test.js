import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCaptionCues, buildAss } from "./captions.js";
import { resolveStyle } from "./styles.js";
import { livePreviewRecipe } from "./live-preview.js";
import { processVideo, validateStyleInput } from "../video-processor.js";

const words = [{ word: "fuck", start: .1, end: .5 }];
test("caption visibility is independent of words, headline and speech censorship", () => {
  const overrides = { caption: { enabled: false } };
  const style = resolveStyle("boxed_red", overrides);
  assert.deepEqual(buildCaptionCues({ words, width: 1080, style: style.caption }), []);
  assert(!buildAss({ words, width: 1080, height: 1920, style: style.caption }).includes("Dialogue:"));
  const preview = livePreviewRecipe({ headline: "KEEP HEADLINE", words, stylePresetId: "boxed_red", styleOverrides: overrides });
  assert.deepEqual(preview.caption.cues, []);
  assert(preview.headline.image.length > 100);
  assert(preview.muteRanges.length > 0);
  assert.equal(words[0].word, "fuck");
  assert(buildCaptionCues({ words, width: 1080, style: resolveStyle("boxed_red", { caption: { enabled: true } }).caption }).length > 0);
  assert.throws(() => validateStyleInput("boxed_red", { caption: { enabled: "false" } }));
});

test("decoded hidden-caption exports retain audio muting in both layouts", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "caption-visibility-"));
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  try {
    const input = path.join(dir, "source.mp4");
    execFileSync(ffmpeg, ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=360x640:r=30:d=0.8",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=0.8", "-c:v", "libx264", "-preset", "ultrafast",
      "-c:a", "aac", "-shortest", input]);
    for (const layout of ["fill", "blurfit"]) {
      const counts = {};
      for (const enabled of [false, true]) {
        const output = path.join(dir, `${layout}-${enabled}.mp4`);
        const result = await processVideo({
          clipPath: input, outputPath: output, jobId: `${layout}-${enabled}`,
          headline: "KEEP MY HEADLINE", words, censorCaptions: true, muteExpletives: true,
          stylePresetId: "boxed_red", styleOverrides: { layout,
            headline: { enabled: false }, caption: { enabled, yPct: 70 } },
        });
        assert.equal(result.words.length, 1);
        assert.equal(result.censorship.audio, true);
        if (!enabled) assert.equal(result.srtPath, null);
        const rgb = execFileSync(ffmpeg, ["-loglevel", "error", "-ss", "0.3", "-i", output,
          "-frames:v", "1", "-vf", "crop=1080:900:0:1000", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
          { maxBuffer: 4_000_000 });
        counts[enabled] = rgb.reduce((n, v) => n + (v > 100 ? 1 : 0), 0);
        const audio = execFileSync(ffmpeg, ["-loglevel", "error", "-i", output, "-af",
          "aresample=async=1:first_pts=0,atrim=start=0.25:end=0.4", "-f", "f32le", "-ac", "1", "-"],
          { maxBuffer: 1_000_000 });
        let peak = 0;
        for (let i = 0; i + 4 <= audio.length; i += 4) peak = Math.max(peak, Math.abs(audio.readFloatLE(i)));
        assert(peak < .002, `speech censoring must remain active (${peak})`);
      }
      assert(counts.false < 50, `${layout}: hidden captions must leave a black source`);
      assert(counts.true > counts.false + 100, `${layout}: re-enabling must restore visible captions`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
