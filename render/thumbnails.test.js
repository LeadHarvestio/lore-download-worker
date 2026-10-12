import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadImage } from "@napi-rs/canvas";
import { createThumbnailService, validateThumbnail } from "./thumbnails.js";
const run = promisify(execFile);
test("thumbnail validation rejects paths, wrong dimensions and out-of-range values", () => {
  const valid = { filename: "final.mp4", atSeconds: .4, width: 1080, height: 1920, format: "png" };
  assert.deepEqual(validateThumbnail(valid), valid);
  for (const bad of [{ filename: "../final.mp4" }, { atSeconds: NaN }, { atSeconds: -1 }, { width: 300 }, { format: "gif" }, { skip: true }]) {
    assert.throws(() => validateThumbnail({ ...valid, ...bad }), error => error.status === 400);
  }
});
test("exact frame extraction, three crops, retained final, and bounded JPEG", { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "thumb-test-"));
  try {
    const input = path.join(dir, "final.mp4");
    await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x284:rate=30:duration=1",
      "-threads", "1", "-c:v", "libx264", "-preset", "ultrafast", input]);
    const service = createThumbnailService(dir);
    service.hold("final.mp4", true); assert.equal(service.held("final.mp4"), true);
    for (const [width, height] of [[1080, 1920], [1080, 1080], [1280, 720]]) {
      const png = await service.extract({ filename: "final.mp4", atSeconds: 11 / 30, width, height, format: "png" });
      const image = await loadImage(png); assert.equal(image.width, width); assert.equal(image.height, height);
      if (height === 1920) {
        const { stdout } = await run("ffmpeg", ["-v", "error", "-threads", "1", "-i", input, "-an",
          "-vf", `select=eq(n\\,11),scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
          "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], { encoding: "buffer", maxBuffer: 12 * 1024 * 1024 });
        assert.deepEqual(png, stdout, "thumbnail equals exact selected final-video frame");
      }
    }
    const jpeg = await service.extract({ filename: "final.mp4", atSeconds: .25, width: 1080, height: 1920, format: "jpg" });
    assert(jpeg.length < 2 * 1024 * 1024);
    service.hold("final.mp4", false); assert.equal(service.held("final.mp4"), false);
    await assert.rejects(service.extract({ filename: "final.mp4", atSeconds: 2, width: 1080, height: 1920, format: "png" }), error => error.status === 400);
    await assert.rejects(service.extract({ filename: "missing.mp4", atSeconds: 0, width: 1080, height: 1920, format: "png" }), error => error.status === 404);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
