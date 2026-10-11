import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { processClip, resolveStyle, OUT_W, OUT_H, PREVIEW_W, PREVIEW_H } from "./process.js";

test("4K finished fill render retains H.264/yuv420p/30fps and 1080p PNG preview geometry", { timeout: 120_000 }, async () => {
  assert.deepEqual([OUT_W, OUT_H], [2160, 3840]);
  assert.deepEqual([PREVIEW_W, PREVIEW_H], [1080, 1920]);
  const dir = mkdtempSync(path.join(tmpdir(), "worker-4k-"));
  try {
    const input = path.join(dir, "source.mp4");
    execFileSync(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi",
      "-i", "color=c=0x334455:size=320x180:rate=30:duration=0.4", "-threads", "1", input]);
    const common = { inputPath: input, headline: { text: "4K FINAL CUT", highlight: ["FINAL"] },
      words: [{ word: "TEST", start: 0, end: 0.4 }], style: resolveStyle("boxed_red", { layout: "fill" }) };
    const output = path.join(dir, "finished.mp4");
    await processClip({ ...common, workDir: path.join(dir, "final"), outputPath: output });
    const result = JSON.parse(execFileSync(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error",
      "-show_entries", "stream=codec_name,width,height,pix_fmt,r_frame_rate", "-of", "json", output], { encoding: "utf8" }));
    assert.deepEqual(result.streams[0], { codec_name: "h264", width: 2160, height: 3840, pix_fmt: "yuv420p", r_frame_rate: "30/1" });
    const preview = path.join(dir, "preview.png");
    await processClip({ ...common, workDir: path.join(dir, "preview"), outputPath: preview, previewAt: 0.1 });
    const png = readFileSync(preview);
    assert.equal(png.readUInt32BE(16), 1080);
    assert.equal(png.readUInt32BE(20), 1920);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
