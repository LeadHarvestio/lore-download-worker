import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createFlash } from "./flash.js";

const run = promisify(execFile);
test("authenticated queue and frame preview retain smooth flashes across repeated source instances", { timeout: 120000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flash-v2-http-"));
  const key = "local-flash-v2-test";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, API_KEY: key, PORT: "0", DOWNLOAD_DIR: dir,
      ENABLE_FACE_TRACKING: "0", FACE_MODEL_PATH: path.join(dir, "no-model.onnx"),
      RENDER_CACHE_DIR: path.join(dir, "cache") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  try {
    const root = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(logs || "Worker failed to start")), 15000);
      const data = chunk => {
        logs += chunk;
        const match = logs.match(/(?:running|listening) on port (\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      };
      child.stdout.on("data", data); child.stderr.on("data", data);
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Worker exited ${code}: ${logs}`)); });
    });
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    const post = (route, body) => fetch(root + route, { method: "POST", headers, body: JSON.stringify(body) });
    await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x605040:s=160x90:r=30:d=3",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=3", "-c:v", "libx264",
      "-preset", "ultrafast", "-threads", "1", "-c:a", "aac", "-shortest", path.join(dir, "source.mp4")]);
    const catalog = await (await fetch(root + "/api/styles", { headers })).json();
    assert.equal(catalog.capabilities.flashBlend, 2);
    assert.equal(catalog.capabilities.affineTransforms, 1);
    assert.equal(catalog.capabilities.sourceInstances, 2);
    const recipe = {
      jobId: "flash_v2_instances", clipFilename: "source.mp4", headline: "TEST", highlightWords: [], words: [],
      sourceEdit: { version: 2, segments: [
        { instanceId: "shot-last", outputStart: 0, srcStart: 2, srcEnd: 2.6 },
        { instanceId: "shot-first", outputStart: .6, srcStart: 0, srcEnd: .6 },
        { instanceId: "shot-repeat", outputStart: 1.2, srcStart: 2, srcEnd: 2.6 },
      ] },
      styleOverrides: { headline: { enabled: false }, layout: "fill",
        effects: [createFlash(0), createFlash(1.4, "negative", "snap")] },
    };
    const queued = await post("/api/process", recipe);
    assert.equal(queued.status, 202, await queued.text());
    let job;
    for (let n = 0; n < 400; n++) {
      job = await (await fetch(root + "/api/process/status/" + recipe.jobId, { headers })).json();
      if (["completed", "failed"].includes(job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.equal(job.status, "completed", JSON.stringify(job) + logs);
    assert.ok(Math.abs(job.durationSeconds - 1.8) < .04);
    const output = path.join(dir, job.filename);
    const { stdout: raw } = await run("ffmpeg", ["-v", "error", "-i", output, "-vf", "scale=16:28",
      "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1000000 });
    const frame = n => [...raw.subarray(n * 16 * 28 * 3, n * 16 * 28 * 3 + 3)];
    assert.ok(frame(15)[1] > frame(0)[1] + 80, "queued output retains the green Pulse");
    assert.ok(frame(45)[0] > frame(41)[0] + 80, "queued output retains the red Snap after repeated footage");
    for (const [at, channel] of [[.5, 1], [1.5, 0]]) {
      const preview = await post("/api/preview", { ...recipe, at });
      assert.equal(preview.status, 200, preview.ok ? "" : await preview.text());
      const png = path.join(dir, `preview-${at}.png`);
      await fs.writeFile(png, Buffer.from(await preview.arrayBuffer()));
      const { stdout: pixel } = await run("ffmpeg", ["-v", "error", "-i", png, "-vf", "scale=1:1",
        "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { encoding: "buffer" });
      assert.ok(Math.abs(pixel[channel] - frame(Math.round(at * 30))[channel]) < 8,
        "frame preview and decoded export agree on the active v2 envelope");
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once("exit", resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
