import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const run = promisify(execFile);
test("authenticated worker advertises and executes source edits through its real HTTP queue", { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-http-"));
  const loader = process.env.WORKER_TEST_LOADER ? ["--loader", process.env.WORKER_TEST_LOADER] : [];
  const child = spawn(process.execPath, [...loader, fileURLToPath(new URL("../server.js", import.meta.url))], {
    env: { ...process.env, PORT: "0", DOWNLOAD_DIR: dir, API_KEY: "isolated-test-only", ENABLE_FACE_TRACKING: "0", RENDER_CACHE_DIR: path.join(dir, "cache") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const deadline = Date.now() + 15000;
  try {
    while (!/running on port (\d+)/.test(output) && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 50));
    const match = output.match(/running on port (\d+)/);
    assert(match, output);
    const root = `http://127.0.0.1:${match[1]}`;
    const headers = { "Content-Type": "application/json", Authorization: "Bearer isolated-test-only" };
    assert.equal((await fetch(root + "/api/styles")).status, 401);
    const catalog = await (await fetch(root + "/api/styles", { headers })).json();
    assert.equal(catalog.capabilities.sourceEdit, 1); assert.equal(catalog.capabilities.thumbnails, 1);
    assert.equal(catalog.capabilities.headlineCoverStyle, 1); assert.equal(catalog.capabilities.faceTracking, 0);
    await run("ffmpeg", ["-y", "-v", "error", "-threads", "1", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=800:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", path.join(dir, "test.mp4")]);
    const body = { jobId: "source_http_test", clipFilename: "test.mp4", headline: "TEST", highlightWords: [], words: [{ word: "TEST", start: 0, end: .4 }],
      stylePresetId: "boxed_red", styleOverrides: { layout: "fill" }, sourceEdit: { segments: [{ srcStart: .5, srcEnd: 1.5, speed: 1 }] } };
    for (const sourceEdit of [{ segments: [{ srcStart: 0, srcEnd: 3 }] }, { segments: [{ srcStart: 0, srcEnd: 2, speed: 5 }] },
      { segments: [{ srcStart: 0, srcEnd: 1 }, { srcStart: .5, srcEnd: 2 }] }]) {
      assert.equal((await fetch(root + "/api/process", { method: "POST", headers, body: JSON.stringify({ ...body, sourceEdit }) })).status, 400);
    }
    const queued = await fetch(root + "/api/process", { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(queued.status, 202, await queued.text());
    let job;
    for (let i = 0; i < 120; i++) {
      job = await (await fetch(root + "/api/process/status/source_http_test", { headers })).json();
      if (job.status === "completed" || job.status === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(job.status, "completed", JSON.stringify(job));
    assert(Math.abs(job.durationSeconds - 1) < 1 / 30);
    const frame = await fetch(root + "/api/thumbnail", { method: "POST", headers,
      body: JSON.stringify({ filename: job.filename, atSeconds: .25, width: 1080, height: 1920, format: "jpg" }) });
    assert.equal(frame.status, 200); assert.equal(frame.headers.get("content-type").split(";")[0], "image/jpeg");
    assert((await frame.arrayBuffer()).byteLength > 1000);
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
    await fs.rm(dir, { recursive: true, force: true });
  }
});
