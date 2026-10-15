import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const run = promisify(execFile);
test("authenticated assembled queue and preview retain output-time panes and creator identity across source cuts", { timeout: 120000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panes-http-"));
  // Test-only local authentication, never a workspace/production credential.
  const key = "local-layout-test";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, API_KEY: key, PORT: "0", DOWNLOAD_DIR: dir,
      ENABLE_FACE_TRACKING: "0", FACE_MODEL_PATH: path.join(dir, "no-model.onnx"), RENDER_CACHE_DIR: path.join(dir, "cache") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const root = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(logs || "Worker failed to start"));
    }, 15000);
    const data = chunk => {
      logs += chunk;
      const match = logs.match(/(?:running|listening) on port (\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    };
    child.stdout.on("data", data); child.stderr.on("data", data);
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Worker exited ${code}: ${logs}`)); });
  });
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const post = (route, body, auth = true) => fetch(root + route, {
    method: "POST", headers: auth ? headers : { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const source = path.join(dir, "fixture.mp4");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x205090:s=360x640:r=30:d=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", source]);
    const tracking = { enabled: true, mode: "selectedFace", zoom: 1.1, smoothness: .7, deadZonePct: 4,
      faceId: "explicit-known-face", startSeconds: 0, endSeconds: 1.5,
      track: Array.from({ length: 16 }, (_, i) => ({ t: i / 10, x: .4, y: .4, w: .1, h: .12, confidence: .95, faceId: "explicit-known-face" })) };
    const body = { jobId: "panes_http", clipFilename: "fixture.mp4", headline: "TEST", highlightWords: [], words: [],
      sourceEdit: { segments: [{ srcStart: .5, srcEnd: 1, speed: 1 }, { srcStart: 1.5, srcEnd: 2, speed: .5, transform: { zoom: 1.2 } }] },
      styleOverrides: { headline: { enabled: false }, source: { cropTopPct: 10 },
        sourcePanes: { topPct: 58, top: { mode: "fill", tracking }, bottom: { mode: "blurfit" } },
        nameTags: [{ id: "11111111-1111-4111-8111-111111111111", text: "CREATOR NAME", startSeconds: .2, endSeconds: .9, color: "#FF49D7", tracking }] } };
    assert.equal((await post("/api/process", body, false)).status, 401);
    assert.equal((await post("/api/preview", body, false)).status, 401);
    assert.equal((await fetch(root + "/api/styles")).status, 401);
    const catalog = await (await fetch(root + "/api/styles", { headers })).json();
    assert.equal(catalog.capabilities.sourcePanes, 1);
    assert.equal(catalog.capabilities.trackedNameTags, 1);
    assert.equal(catalog.capabilities.faceTracking, 0, "rendering cached face selection must not start analysis");
    for (const styleOverrides of [
      { ...body.styleOverrides, nameTags: [{ ...body.styleOverrides.nameTags[0], endSeconds: 3.3 }] },
      { ...body.styleOverrides, nameTags: [{ ...body.styleOverrides.nameTags[0], tracking: { ...tracking, faceId: undefined } }] },
      { ...body.styleOverrides, sourcePanes: { ...body.styleOverrides.sourcePanes, topPct: 99 } },
    ]) {
      assert.equal((await post("/api/process", { ...body, styleOverrides })).status, 400);
      assert.equal((await post("/api/preview", { ...body, styleOverrides })).status, 400);
      assert.equal((await post("/api/live-preview", { ...body, styleOverrides })).status, 400);
    }
    const queued = await post("/api/process", body);
    assert.equal(queued.status, 202, await queued.text());
    let job;
    for (let n = 0; n < 200; n++) {
      job = await (await fetch(root + "/api/process/status/panes_http", { headers })).json();
      if (["completed", "failed"].includes(job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(job.status, "completed", JSON.stringify(job) + logs);
    assert.ok(Math.abs(job.durationSeconds - 1.5) < .04, "source cuts/speed applied once");
    const preview = await post("/api/preview", { ...body, at: .4 });
    assert.equal(preview.status, 200, preview.ok ? "" : await preview.text());
    const previewBytes = Buffer.from(await preview.arrayBuffer());
    const filename = path.join(dir, job.filename);
    const { stdout: finalBytes } = await run("ffmpeg", ["-loglevel", "error", "-ss", "0.4", "-i", filename, "-frames:v", "1",
      "-f", "image2pipe", "-c:v", "png", "-threads", "1", "-"], { encoding: "buffer", maxBuffer: 10000000 });
    async function bounds(bytes) {
      const img = await loadImage(bytes), c = createCanvas(img.width, img.height), ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      assert.equal(img.width, 1080); assert.equal(img.height, 1920);
      const data = ctx.getImageData(0, 0, img.width, img.height).data;
      let count = 0, x = 0, y = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] > 180 && data[i + 1] < 140 && data[i + 2] > 140) {
        count++; x += (i / 4) % img.width; y += Math.floor(i / 4 / img.width);
      }
      assert.ok(count > 200, "selected creator label is visible, not silently dropped");
      return { x: x / count, y: y / count };
    }
    const a = await bounds(previewBytes), b = await bounds(finalBytes);
    assert.ok(Math.abs(a.x - b.x) < 4 && Math.abs(a.y - b.y) < 4, "PNG and decoded MP4 agree on label position");
    const thumb = await post("/api/thumbnail", { filename: job.filename, atSeconds: .4, width: 1080, height: 1920, format: "jpg" });
    assert.equal(thumb.status, 200); assert.ok((await thumb.arrayBuffer()).byteLength > 1000);
    assert.ok(!logs.includes("[FaceAnalysis]"), "no new detection request");
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise(resolve => child.once("exit", resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
