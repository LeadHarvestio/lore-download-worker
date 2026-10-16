import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createFlash, combinedFlashRGB, screenFlashPixel } from "./flash.js";
import { effectSchema } from "./motion-effects.js";
import { prepareCreativeInputs } from "./creative.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const ffmpeg = args => execFileSync("ffmpeg", ["-v", "error", "-filter_complex_threads", "1", ...args], { maxBuffer: 32e6 });
test("v2 native creative integration, unequal overlaps and source-clock preview offset", async () => {
  const effects = [createFlash(.3), { ...createFlash(.5, "negative"), peakOpacity: .23 }];
  for (const e of effects) assert.equal(effectSchema.safeParse(e).success, true);
  for (const patch of [{ rampInFrames: 1 }, { peakOpacity: 4 }, { type: "shake" }, { holdFrames: undefined }])
    assert.equal(effectSchema.safeParse({ ...effects[0], ...patch }).success, false);
  const input = ["-f", "lavfi", "-i", "color=c=0x605040:s=64x64:r=30:d=2"];
  const output = ["-pix_fmt", "rgb24", "-f", "rawvideo", "-"];
  const base = ffmpeg([...input, "-vf", "format=gbrp,format=rgb24", ...output]);
  const graph = await prepareCreativeInputs({ style: { effects }, args: [], nextIndex: 1,
    width: 64, height: 64, duration: 2, initialLabel: "0:v" });
  const raw = ffmpeg([...input, "-filter_complex", graph.filters.join(";"), "-map", `[${graph.label}]`, ...output]);
  for (let frame = 0; frame < 60; frame++) {
    const i = frame * 64 * 64 * 3;
    const expected = screenFlashPixel([base[i], base[i+1], base[i+2]], combinedFlashRGB(effects, frame / 30));
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(raw[i+c] - expected[c]) <= 2.01);
  }
  const preview = await prepareCreativeInputs({ style: { effects }, args: [], nextIndex: 1,
    width: 64, height: 64, duration: 2, previewAt: .8, initialLabel: "0:v" });
  const png = ffmpeg([...input, "-filter_complex", preview.filters.join(";"), "-map", `[${preview.label}]`, "-frames:v", "1", ...output]);
  for (let c = 0; c < 3; c++) assert.equal(png[c], raw[24 * 64 * 64 * 3 + c]);
});
test("complete 1080p30 renderer retains source-cut clock/audio with v2 flashes", { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flash-v2-native-"));
  const oldCache = process.env.RENDER_CACHE_DIR;
  process.env.RENDER_CACHE_DIR = path.join(dir, "cache");
  try {
    const source = path.join(dir, "source.mp4"), out = path.join(dir, "out.mp4");
    ffmpeg(["-f", "lavfi", "-i", "color=c=0x605040:s=160x90:r=30:d=3",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=3", "-c:v", "libx264", "-preset", "ultrafast",
      "-c:a", "aac", "-shortest", source]);
    const { processVideo } = await import("../video-processor.js");
    const result = await processVideo({ jobId: "flash-v2-native", clipPath: source, outputPath: out,
      headline: "", highlightWords: [], words: [], sourceEdit: { segments: [
        { srcStart: 0, srcEnd: .6 }, { srcStart: 1, srcEnd: 1.6 }, { srcStart: 2, srcEnd: 2.6 },
      ] }, styleOverrides: { headline: { enabled: false }, layout: "fill",
        effects: [createFlash(0), createFlash(1.4, "negative", "snap")] },
      transcribeWords: () => { throw new Error("Paid transcription is forbidden in this test"); } });
    assert.equal(result.outputWidth, 1080);
    assert.equal(result.outputHeight, 1920);
    assert.ok(Math.abs(result.durationSeconds - 1.8) < 1/30 + .001);
    const meta = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", out], { encoding: "utf8" }));
    const v = meta.streams.find(s => s.codec_type === "video"), a = meta.streams.find(s => s.codec_type === "audio");
    assert.equal(v.r_frame_rate, "30/1");
    assert.ok(Math.abs(Number(v.duration) - Number(a.duration)) < 1/30 + .001);
    const raw = ffmpeg(["-i", out, "-vf", "scale=16:28", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]);
    const frame = n => [...raw.subarray(n*16*28*3, n*16*28*3+3)];
    assert.ok(frame(15)[1] > frame(0)[1] + 80, "green Pulse really appears in decoded full export");
    assert.ok(frame(45)[0] > frame(41)[0] + 80, "red Snap really appears after source cut");
  } finally {
    if (oldCache === undefined) delete process.env.RENDER_CACHE_DIR; else process.env.RENDER_CACHE_DIR = oldCache;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
