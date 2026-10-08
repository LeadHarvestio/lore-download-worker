import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { sourceSettings, foregroundGeometry, layoutFilter } from "./framing.js";
import { processClip, resolveStyle } from "./process.js";
import { headlinePosition } from "./placement.js";

test("source editing defaults and bounds are explicit", () => {
  assert.deepEqual(sourceSettings(), { cropLeftPct: 0, cropRightPct: 0, cropTopPct: 0, cropBottomPct: 0, zoom: 1, muteAudio: false });
  for (const bad of [{ zoom: 0.9 }, { zoom: 3.1 }, { cropLeftPct: 41 }, { cropTopPct: -1 }, { cropBottomPct: NaN },
    { muteAudio: "true" }, { zoom: "2" }, { constructor: 1 }, { extra: 0 }, null]) {
    assert.throws(() => sourceSettings(bad));
  }
  const g = foregroundGeometry(320, 180, 1080, 1920, { cropLeftPct: 10, cropRightPct: 10, zoom: 1.5 });
  assert.equal(g.croppedWidth, 256);
  assert.equal(g.croppedHeight, 180);
  assert.equal(g.width, 1620);
  assert.equal(g.height % 2, 0);
});

test("zoom leaves the background filter intact and fill ignores blurfit-only crop/zoom", () => {
  const a = layoutFilter("blurfit", 1080, 1920, 320, 180);
  const b = layoutFilter("blurfit", 1080, 1920, 320, 180, { zoom: 2 });
  assert.equal(a.split(";")[1], b.split(";")[1]);
  assert.notEqual(a.split(";")[2], b.split(";")[2]);
  assert.equal(layoutFilter("fill", 1080, 1920, 320, 180),
    layoutFilter("fill", 1080, 1920, 320, 180, { cropLeftPct: 40, zoom: 3 }));
});

test("automatic headline accounts for cropped and zoomed foreground geometry", () => {
  const style = resolveStyle("boxed_red", { source: { cropLeftPct: 10, cropRightPct: 10, zoom: 1.5 } });
  const headline = { width: 600, height: 90, visibleBox: { x: 0, y: 0, width: 600, height: 90 } };
  const geometry = foregroundGeometry(320, 180, 1080, 1920, style.source);
  const y = headlinePosition({ sourceWidth: 320, sourceHeight: 180, width: 1080, height: 1920, headline, style });
  assert.ok(y + 90 <= (1920 - geometry.height) / 2 - 27);
});

test("real PNG frames remove source edge overlays and zoom only the sharp video", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "worker-source-framing-"));
  try {
    const input = path.join(dir, "edges.mp4");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i",
      "color=c=0x205090:size=320x180:rate=30:duration=0.4,drawbox=x=0:y=0:w=32:h=ih:color=red:t=fill,drawbox=x=288:y=0:w=32:h=ih:color=red:t=fill,drawbox=x=0:y=0:w=iw:h=18:color=red:t=fill,drawbox=x=0:y=162:w=iw:h=18:color=red:t=fill",
      "-threads", "1", input]);
    async function frame(name, source) {
      const output = path.join(dir, `${name}.png`);
      await processClip({ inputPath: input, workDir: path.join(dir, name), outputPath: output, previewAt: 0.1,
        headline: { text: "FRAME TEST", highlight: [] }, words: [],
        style: resolveStyle("boxed_red", { source, headline: { autoPosition: false, yPct: 10 } }) });
      const image = await loadImage(output);
      const canvas = createCanvas(image.width, image.height);
      canvas.getContext("2d").drawImage(image, 0, 0);
      return (x, y) => Array.from(canvas.getContext("2d").getImageData(x, y, 1, 1).data);
    }
    const edges = await frame("original", {});
    const source = { cropLeftPct: 10, cropRightPct: 10, cropTopPct: 10, cropBottomPct: 10 };
    const crop = await frame("cropped", source);
    const zoom = await frame("zoomed", { ...source, zoom: 2 });
    assert.ok(edges(20, 960)[0] > 200, "Original red edge overlay is visible");
    assert.ok(crop(20, 960)[0] < 100 && crop(20, 960)[2] > 100, "Crop removes the red edge");
    assert.deepEqual(crop(20, 20), zoom(20, 20), "Zoom does not change the blurred background");
    assert.notDeepEqual(crop(540, 500), zoom(540, 500), "Zoom enlarges the sharp source");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("original-audio toggle silences voice, can be reversed, and preserves music and captions", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "worker-source-audio-"));
  try {
    const input = path.join(dir, "voice.mp4"), music = path.join(dir, "music.wav");
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:size=320x180:rate=30:duration=0.4",
      "-f", "lavfi", "-i", "sine=frequency=600:duration=0.4", "-shortest", "-threads", "1", "-c:a", "aac", input]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=1200:duration=1", music]);
    const { processVideo } = await import("../video-processor.js");
    async function audio(name, muteAudio, musicFilePath) {
      const output = path.join(dir, `${name}.mp4`);
      const result = await processVideo({ jobId: name, clipPath: input, outputPath: output, headline: "AUDIO TEST",
        highlightWords: [], musicFilePath, styleOverrides: { source: { muteAudio, ...(musicFilePath ? { cropLeftPct: 10, cropBottomPct: 10, zoom: 1.25 } : {}) }, layout: musicFilePath ? "blurfit" : "fill" },
        words: [{ word: "caption", start: 0.05, end: 0.3 }] });
      assert.equal(result.words[0].word, "caption", "Caption transcription survives original-audio muting");
      assert.equal(result.outputWidth, 2160);
      assert.equal(result.outputHeight, 3840);
      const data = execFileSync("ffmpeg", ["-v", "error", "-i", output, "-map", "0:a:0", "-f", "f32le", "-ac", "1", "-ar", "44100", "-"]);
      const samples = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
      return Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
    }
    const silent = await audio("muted", true);
    const voice = await audio("unmuted", false);
    const withMusic = await audio("muted-with-music", true, music);
    assert.ok(silent < 1e-6, `Muted source must be silent, RMS=${silent}`);
    assert.ok(voice > 0.005, "Unmuted source retains audible voice");
    assert.ok(withMusic > 0.001, "Music remains audible when original audio is muted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
