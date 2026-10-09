import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { prepareCreativeInputs, edgedCutout, validateAssetUrl } from "./creative.js";
import { buildAss, buildCaptionCues } from "./captions.js";
import { PRESETS, FONTS } from "./styles.js";
const run = promisify(execFile);
const uuid = "19ca23c4-a153-44db-8ff7-d812f3f1c580";

test("context fetch only permits public app asset routes", () => {
  assert.equal(validateAssetUrl(`https://example.replit.app/api/editing-assets/${uuid}/file`, uuid).protocol, "https:");
  for (const url of [
    `http://example.replit.app/api/editing-assets/${uuid}/file`,
    `https://127.0.0.1/api/editing-assets/${uuid}/file`,
    `https://example.replit.app:8000/api/editing-assets/${uuid}/file`,
    `https://example.replit.app/api/clips/file/${uuid}.mp4`,
    `https://attacker.example/api/editing-assets/${uuid}/file`,
  ]) assert.throws(() => validateAssetUrl(url, uuid));
});

test("Integral is default; reference preserves masking, colors and progressive words", () => {
  assert.equal(PRESETS.boxed_red.caption.font, "Integral CF Extra Bold");
  assert.equal(Object.keys(FONTS).filter(f => f.startsWith("Integral")).length, 6);
  const style = { ...PRESETS.boxed_red.caption, wordsPerChunk: 2, stacked: true };
  const words = [{ word: "this", start: 0, end: .4 }, { word: "n*gga", color: "#FFE600", start: .4, end: .9 }];
  const cues = buildCaptionCues({ words, width: 1080, style });
  assert.equal(cues[0].words.length, 1);
  assert.equal(cues[1].words[1].color, "#FFE600");
  const ass = buildAss({ words, width: 1080, height: 1920, style });
  assert.ok(ass.includes("N*GGA"));
  assert.ok(ass.includes("\\N"));
  assert.ok(ass.includes("\\fscx128"));
  assert.ok(ass.includes("&H00E6FF&"));
});

test("cutout edge follows alpha silhouette and retains transparent corners", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cutout-edge-"));
  try {
    const canvas = createCanvas(64, 96), ctx = canvas.getContext("2d");
    ctx.fillStyle = "#00FF00"; ctx.fillRect(10, 12, 44, 72);
    const file = path.join(dir, "person.png"); await fs.writeFile(file, canvas.toBuffer("image/png"));
    const output = await edgedCutout(file, 64, { enabled: true, color: "#FFFFFF", widthPct: .4, blurPct: .8 }, dir);
    const image = await loadImage(output), result = createCanvas(image.width, image.height), pixels = result.getContext("2d");
    pixels.drawImage(image, 0, 0);
    const padding = Math.round((image.width - 64) / 2);
    const edge = pixels.getImageData(padding + 8, padding + 40, 1, 1).data;
    assert.ok(edge[0] > 200 && edge[1] > 200 && edge[2] > 200 && edge[3] > 0);
    assert.equal(pixels.getImageData(0, 0, 1, 1).data[3], 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("real FFmpeg output respects overlays, split timing, flashes and original audio", { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "creative-render-"));
  try {
    const main = path.join(dir, "main.mp4"), secondary = path.join(dir, "context.mp4"), png = path.join(dir, "person.png"), out = path.join(dir, "cut.mp4");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=320x180:r=15:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", "-shortest", main]);
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=160x240:r=15:d=2", "-c:v", "libx264", "-threads", "1", secondary]);
    const image = createCanvas(64, 96), ctx = image.getContext("2d"); ctx.fillStyle = "#00FF00"; ctx.fillRect(0, 0, 64, 96); await fs.writeFile(png, image.toBuffer("image/png"));
    const args = ["-v", "error", "-filter_complex_threads", "1", "-i", main];
    const shape = { assetId: uuid, xPct: 50, yPct: 70, widthPct: 30, heightPct: 30, trimStartSeconds: 0, enterAnimation: "none" };
    const result = await prepareCreativeInputs({
      args, nextIndex: 1, originalIndex: 0, originalPath: main, width: 320, height: 568, duration: 2,
      style: { layers: [
        { ...shape, kind: "cutout", mode: "overlay", startSeconds: .2, endSeconds: .8 },
        { ...shape, kind: "video", mode: "split-top", startSeconds: 1, endSeconds: 1.5 },
      ], effects: [{ type: "shake", strengthPct: .6, startSeconds: .2, endSeconds: .7 },
        { type: "shake", strengthPct: 1, startSeconds: .3, endSeconds: .6 },
        { type: "flash", color: "#00FF00", opacity: .5, startSeconds: 1.6, endSeconds: 1.9 }] },
    }, async layer => layer.kind === "cutout" ? png : secondary);
    args.push("-filter_complex", ["[0:v]scale=320:568[base]", ...result.filters].join(";"), "-map", `[${result.label}]`, "-map", "0:a", "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-c:a", "aac", "-t", "2", out);
    await run("ffmpeg", args, { timeout: 45000 });
    async function pixel(t, x, y) {
      const { stdout } = await run("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-vf", `crop=2:2:${x}:${y},scale=1:1`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-threads", "1", "-"], { encoding: "buffer" });
      return [...stdout];
    }
    assert.ok((await pixel(.1, 160, 100))[2] > 180);
    assert.ok((await pixel(.4, 160, 396))[1] > 150);
    assert.ok((await pixel(1.2, 160, 100))[0] > 180);
    assert.ok((await pixel(1.2, 160, 450))[2] > 180);
    assert.ok((await pixel(1.7, 160, 100))[1] > 90);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", out]);
    assert.ok(JSON.parse(stdout).streams.some(s => s.codec_type === "audio"));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
