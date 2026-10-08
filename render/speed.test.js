import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRenderCache } from "./cache.js";
import { livePreviewRecipe } from "./live-preview.js";
import { buildAss } from "./captions.js";
import { resolveStyle } from "./styles.js";
import { orderRenderJobs } from "./priority.js";
import { layoutFilter } from "./framing.js";
import { processClip, probe } from "./process.js";

test("live recipe shares export caption timing, keeps literal stars, and never invokes FFmpeg", () => {
  const oldBin = process.env.FFMPEG_BIN;
  process.env.FFMPEG_BIN = "/does-not-exist";
  try {
    const words = [{ word: "fuck", start: .4, end: .8 }, { word: "okay", start: .85, end: 1.2 }];
    const recipe = livePreviewRecipe({ headline: "A NEW CLIP", words, censorCaptions: true });
    assert.match(recipe.headline.image, /^data:image\/png;base64,/);
    assert.equal(recipe.width, 1080); assert.equal(recipe.height, 1920);
    assert.ok(recipe.headline.visibleBox.height > 0);
    assert.equal(recipe.caption.cues[0].words[0].text, "F*CK");
    assert.equal(recipe.caption.cues[0].start, .4);
    assert.equal(recipe.caption.cues[0].end, .85);
    assert.equal(recipe.muteRanges.length, 1);
    assert.ok(recipe.muteRanges[0].start < .4 && recipe.muteRanges[0].end > .8);
    const ass = buildAss({ words: words.map(w => ({ ...w, word: w.word === "fuck" ? "f*ck" : w.word })), width: 1080, height: 1920, style: resolveStyle("boxed_red").caption });
    assert.match(ass, /0:00:00\.40,0:00:00\.85/);
    assert.equal(livePreviewRecipe({ headline: "SILENT", words: [] }).transcriptAvailable, true);
    assert.equal(livePreviewRecipe({ headline: "NOT TRANSCRIBED" }).transcriptAvailable, false);
  } finally {
    if (oldBin === undefined) delete process.env.FFMPEG_BIN; else process.env.FFMPEG_BIN = oldBin;
  }
});

test("interactive priority preserves FIFO ties and ages batches to prevent starvation", () => {
  const jobs = new Map([
    ["batch", { queuedAt: 1, priority: "batch" }],
    ["edit", { queuedAt: 2, priority: "interactive" }],
    ["edit2", { queuedAt: 3, priority: "interactive" }],
  ]);
  assert.deepEqual(orderRenderJobs(["batch", "edit", "edit2"], jobs, 100), ["edit", "edit2", "batch"]);
  assert.deepEqual(orderRenderJobs(["batch", "edit", "edit2"], jobs, 300002), ["batch", "edit", "edit2"]);
});

test("cache deduplicates producers, survives failures, protects leased files and enforces its bound", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "render-cache-test-"));
  try {
    const cache = createRenderCache({ directory, maxBytes: 4 });
    let produced = 0;
    const make = dest => { produced++; fs.writeFileSync(dest, "video"); };
    const [a, b] = await Promise.all([cache.acquire("base", { crop: 0 }, "mp4", make), cache.acquire("base", { crop: 0 }, "mp4", make)]);
    assert.equal(produced, 1); assert.equal(a.file, b.file);
    assert.ok(fs.existsSync(a.file));
    a.release(); assert.ok(fs.existsSync(b.file));
    b.release(); assert.equal(fs.existsSync(b.file), false);
    await assert.rejects(cache.acquire("base", "failed", "mp4", dest => { fs.writeFileSync(dest, "partial"); throw Error("failed"); }), /failed/);
    assert.equal(fs.readdirSync(directory).length, 0);
    const recovered = await cache.acquire("base", "failed", "mp4", make);
    assert.ok(fs.existsSync(recovered.file)); recovered.release();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("layout reduces FPS before work and blurs only a quarter-size background", () => {
  const filter = layoutFilter("blurfit", 1080, 1920, 1920, 1080);
  assert.ok(filter.indexOf("fps=30") < filter.indexOf("split=2"));
  assert.match(filter, /crop=270:480,boxblur=10:6/);
  assert.match(filter, /scale=1080:1920\[bg\]/);
});

test("re-edits reuse background and voice, but crop changes invalidate background only", { timeout: 120000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "render-speed-test-"));
  try {
    const inputPath = path.join(directory, "source.mp4");
    execFileSync(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=60:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-threads", "1", "-shortest", inputPath]);
    const run = async (name, style) => processClip({ inputPath, outputPath: path.join(directory, name + ".mp4"), workDir: path.join(directory, name), headline: { text: name.toUpperCase(), highlight: [] }, style, words: [] });
    const first = await run("first", resolveStyle("boxed_red"));
    const edit = await run("second", resolveStyle("boxed_red", { headline: { yPct: 30 }, caption: { sizePct: 10 }, source: { muteAudio: true } }));
    assert.equal(first.renderStats.cacheHits.background, false);
    assert.equal(edit.renderStats.cacheHits.background, true);
    assert.equal(edit.renderStats.cacheHits.voice, true);
    const crop = await run("crop", resolveStyle("boxed_red", { source: { cropBottomPct: 10 } }));
    assert.equal(crop.renderStats.cacheHits.background, false);
    assert.equal(crop.renderStats.cacheHits.voice, true);
    const output = await probe(path.join(directory, "second.mp4"));
    assert.equal(output.width, 1080); assert.equal(output.height, 1920);
    assert.ok(output.hasAudio);
    await processClip({ inputPath, outputPath: path.join(directory, "gated.mp4"), workDir: path.join(directory, "gated"),
      headline: { text: "CENSOR TEST", highlight: [] }, style: resolveStyle("boxed_red"), words: [],
      muteRanges: [{ start: .36, end: .66 }] });
    const audio = execFileSync(process.env.FFMPEG_BIN || "ffmpeg", ["-v", "error", "-i", path.join(directory, "gated.mp4"), "-vn", "-ac", "1", "-ar", "44100", "-f", "f32le", "pipe:1"]);
    const samples = new Float32Array(audio.buffer, audio.byteOffset, audio.length / 4);
    const rms = (start, end) => {
      const range = samples.subarray(Math.floor(start * 44100), Math.floor(end * 44100));
      return Math.sqrt(range.reduce((sum, value) => sum + value * value, 0) / range.length);
    };
    assert.ok(rms(.1, .25) > .01, "Original voice remains audible outside the censor interval.");
    assert.ok(rms(.4, .6) < .001, "Cached loudness-normalized voice must still censor the entire word.");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
