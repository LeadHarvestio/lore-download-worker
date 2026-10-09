import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCanvas } from "@napi-rs/canvas";
import { loadImage } from "@napi-rs/canvas";
import crypto from "node:crypto";
import { previewFrame } from "../video-processor.js";
import { prepareCreativeInputs } from "./creative.js";
const run = promisify(execFile);
const base = { id: "c5100000-8dc7-4a19-9f71-000000000000", assetId: "c5100001-8dc7-4a19-9f71-000000000001",
  kind: "video", mode: "overlay", anchor: "end", mediaDurationSeconds: 1, audio: true,
  startSeconds: 0, endSeconds: 1, xPct: 50, yPct: 70, widthPct: 50, heightPct: 25, trimStartSeconds: 0, enterAnimation: "none" };
test("end timing follows actual duration, skips early previews, and supports short clips", async () => {
  let resolved = 0;
  for (const [duration, at, count] of [[60, 20, 0], [60, 59.5, 1], [.5, .25, 1]]) {
    const args = [];
    const result = await prepareCreativeInputs({ style: { layers: [base] }, args, nextIndex: 1, width: 320, height: 568, duration, previewAt: at },
      async () => { resolved++; return "fixture.mov"; });
    assert.equal(result.nextIndex - 1, count);
    assert.equal(result.audioLabels.length, 0);
  }
  assert.equal(resolved, 2);
});
test("encoded alpha overlay and audio only occur at the tail without muting the base", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subscribe-"));
  try {
    const png = path.join(dir, "sprite.png"), mov = path.join(dir, "animation.mov"), main = path.join(dir, "main.mp4"), out = path.join(dir, "out.mp4");
    const image = createCanvas(160, 80), ctx = image.getContext("2d");
    ctx.fillStyle = "#00FF00"; ctx.fillRect(48, 20, 64, 40); await fs.writeFile(png, image.toBuffer("image/png"));
    await run("ffmpeg", ["-v", "error", "-y", "-loop", "1", "-i", png, "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
      "-t", "1", "-c:v", "qtrle", "-pix_fmt", "argb", "-c:a", "pcm_s16le", "-threads", "1", mov]);
    await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=blue:s=320x568:r=15:d=3", "-c:v", "libx264", "-threads", "1", main]);
    const args = ["-v", "error", "-y", "-filter_complex_threads", "1", "-i", main];
    const creative = await prepareCreativeInputs({ style: { layers: [base] }, args, nextIndex: 1, width: 320, height: 568, duration: 3 }, async () => mov);
    args.push("-filter_complex", ["[0:v]null[base]", ...creative.filters, ...creative.audioFilters].join(";"), "-map", `[${creative.label}]`,
      "-map", `[${creative.audioLabels[0]}]`, "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-c:a", "aac", "-t", "3", out);
    await run("ffmpeg", args, { timeout: 30000 });
    async function pixel(t, x) {
      const { stdout } = await run("ffmpeg", ["-v", "error", "-ss", String(t), "-i", out, "-vf", `crop=2:2:${x}:396,scale=1:1`,
        "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { encoding: "buffer" });
      return [...stdout];
    }
    const before = await pixel(1, 160), visible = await pixel(2.5, 160), transparent = await pixel(2.5, 84);
    assert.ok(before[2] > 200 && before[1] < 30);
    assert.ok(visible[1] > 200 && visible[2] < 30);
    assert.ok(transparent[2] > 200 && transparent[1] < 30, "Transparent margins must preserve the underlying video");
    const { stdout } = await run("ffmpeg", ["-v", "error", "-i", out, "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"], { encoding: "buffer" });
    let early = 0, tail = 0;
    for (let i = 0; i < stdout.length / 4; i++) {
      const sample = Math.abs(stdout.readFloatLE(i * 4));
      if (i < 12000) early = Math.max(early, sample);
      if (i >= 17600) tail = Math.max(tail, sample);
    }
    assert.ok(early < .001 && tail > .05, "Sound must be delayed to the outro");
    const silent = await prepareCreativeInputs({ style: { layers: [{ ...base, audio: false }] }, args: [], nextIndex: 1, width: 320, height: 568, duration: 3 }, async () => mov);
    assert.equal(silent.audioLabels.length, 0);
    // Static PNG output has a one-second render window, but its animation
    // must still be anchored to the actual three-second source duration.
    const assetUrl = `https://example.replit.app/api/editing-assets/${base.assetId}/file`;
    const cached = path.resolve("uploads/context-assets", `${crypto.createHash("sha256").update(assetUrl).digest("hex")}.mp4`);
    await fs.mkdir(path.dirname(cached), { recursive: true });
    await fs.copyFile(mov, cached);
    try {
      for (const [at, visible] of [[1, false], [2.5, true]]) {
        const frame = path.join(dir, `static-${at}.png`);
        await previewFrame({ clipPath: main, outputPath: frame, workDir: path.join(dir, `work-${at}`),
          headline: "STATIC CHECK", highlightWords: [], words: [{ word: "CHECK", start: 0, end: 3 }],
          styleOverrides: { layers: [{ ...base, assetUrl }], caption: { yPct: 15 } }, at });
        const image = await loadImage(frame), canvas = createCanvas(image.width, image.height), ctx = canvas.getContext("2d");
        ctx.drawImage(image, 0, 0);
        const pixel = ctx.getImageData(Math.round(image.width * .5), Math.round(image.height * .7), 1, 1).data;
        assert.ok(visible ? pixel[1] > 200 && pixel[2] < 30 : pixel[2] > 200 && pixel[1] < 30,
          "Static preview must use actual source duration for end alignment");
      }
    } finally { await fs.rm(cached, { force: true }); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
