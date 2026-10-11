import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { prepareCreativeInputs } from "./creative.js";

test("ordinary image overlays use both dimensions without requiring alpha", async () => {
  const args = [], id = "f8f0900b-9e3f-4dfd-bb40-c771293a9044";
  const plan = await prepareCreativeInputs({ args, nextIndex: 1, width: 1080, height: 1920,
    duration: 2, originalIndex: 0, style: { layers: [{ id, assetId: id, kind: "image", mode: "overlay",
      startSeconds: 0, endSeconds: 2, xPct: 25, yPct: 65, widthPct: 40, heightPct: 30 }] } }, async () => "opaque.png");
  assert.ok(args.includes("-loop"));
  assert.match(plan.filters.join(";"), /scale=432:576:force_original_aspect_ratio=decrease/);
  assert.match(plan.filters.join(";"), /overlay=x=W\*0.25-w\/2:y=H\*0.65-h\/2/);
});

test("actual 4K image split keeps whole picture, moves main footage, honors timing and audio", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "image-split-native-"));
  try {
    const imagePath = path.join(dir, "photo.png"), output = path.join(dir, "final.mp4");
    const canvas = createCanvas(200, 100), ctx = canvas.getContext("2d");
    ctx.fillStyle = "#00DD00"; ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = "#DD0000"; ctx.fillRect(100, 0, 100, 100);
    writeFileSync(imagePath, canvas.toBuffer("image/png"));
    const id = "f8f0900b-9e3f-4dfd-bb40-c771293a9044";
    const args = ["-v", "error", "-filter_complex_threads", "1", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=1.2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2"];
    const plan = await prepareCreativeInputs({ args, nextIndex: 2, width: 2160, height: 3840, duration: 1.2,
      originalIndex: 0, style: { videoFilter: { preset: "mono" }, layers: [{ id, assetId: id, kind: "image", mode: "split-top",
        startSeconds: .3, endSeconds: .9, xPct: 50, yPct: 50, widthPct: 40, heightPct: 30 }] } }, async () => imagePath);
    args.push("-filter_complex", ["[0:v]scale=2160:3840,setsar=1[base]", ...plan.filters].join(";"),
      "-map", `[${plan.label}]`, "-map", "1:a:0", "-t", "1.2", "-r", "30", "-c:v", "libx264",
      "-preset", "ultrafast", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", output);
    execFileSync("ffmpeg", args);
    const meta = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate", "-of", "json", output]));
    assert.equal(meta.streams.find(s => s.codec_type === "video").width, 2160);
    assert.equal(meta.streams.find(s => s.codec_type === "video").height, 3840);
    assert.ok(meta.streams.some(s => s.codec_type === "audio"));
    const rgb = time => execFileSync("ffmpeg", ["-v", "error", "-threads", "1", "-ss", String(time), "-i", output,
      "-frames:v", "1", "-vf", "scale=108:192", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 108 * 192 * 3 + 1000 });
    const pixel = (data, x, y) => [...data.subarray((y * 108 + x) * 3, (y * 108 + x) * 3 + 3)];
    const middle = rgb(.5), first = rgb(.1), last = rgb(1.05);
    const green = pixel(middle, 15, 40), red = pixel(middle, 95, 40), main = pixel(middle, 54, 145);
    assert.ok(green[1] > 120 && green[0] < 50, "left edge of full picture visible");
    assert.ok(red[0] > 120 && red[1] < 50, "right edge of full picture visible");
    assert.ok(Math.max(...main) - Math.min(...main) < 10, "main footage filter retained in opposite half");
    assert.ok(pixel(middle, 54, 5).every(v => v < 20), "image letterboxing is black");
    assert.ok(pixel(first, 54, 40)[2] > 150 && pixel(last, 54, 40)[2] > 150, "split restores original frame outside interval");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
