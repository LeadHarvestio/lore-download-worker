import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("20 real renders wait their turn, expose actual start time, and continue after one fails", { timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-render-queue-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, "fixture.mp4");
  execFileSync(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:size=160x90:rate=15:duration=0.4", "-threads", "1", fixture]);
  fs.writeFileSync(path.join(dir, "invalid.mp4"), "not a video");
  const worker = spawn(process.execPath, ["server.js"], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, PORT: "0", API_KEY: "local-render-queue-key", DOWNLOAD_DIR: dir, MAX_CONCURRENT_RENDERS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  worker.stdout.on("data", (chunk) => { log += chunk; });
  worker.stderr.on("data", (chunk) => { log += chunk; });
  t.after(async () => { worker.kill(); await Promise.race([once(worker, "exit"), new Promise((r) => setTimeout(r, 3000))]); });
  let base;
  for (let i = 0; i < 100 && !base; i++) {
    const match = log.match(/Download worker running on port (\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.ok(base, log);
  const headers = { Authorization: "Bearer local-render-queue-key", "Content-Type": "application/json" };
  const body = (index) => ({ jobId: `render-batch-${index}`, clipFilename: index === 3 ? "invalid.mp4" : "fixture.mp4", headline: "A TEST CUT", highlightWords: [], words: [], ...(index === 19 ? { priority: "interactive" } : {}) });
  const get = async (route) => { const r = await fetch(base + route, { headers }); assert.equal(r.status, 200); return r.json(); };
  const accepted = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const r = await fetch(base + "/api/process", { method: "POST", headers, body: JSON.stringify(body(i)) });
    assert.equal(r.status, 202, log);
    return r.json();
  }));
  const initial = await Promise.all(accepted.map((job) => get("/api/process/status/" + job.jobId)));
  const waiting = initial.filter((job) => job.status === "queued");
  assert.ok(waiting.length > 0);
  for (const job of waiting) {
    assert.equal(job.startedAt, undefined);
    assert.ok(job.queuedAt > 0);
    assert.ok(job.queuePosition > 0);
  }
  const queue = await get("/api/process/queue");
  assert.equal(queue.limit, 1);
  assert.ok(queue.active <= 1);
  const duplicateIndex = Number(waiting[waiting.length - 1].jobId.split("-").at(-1));
  const duplicate = await fetch(base + "/api/process", { method: "POST", headers, body: JSON.stringify(body(duplicateIndex)) });
  assert.equal(duplicate.status, 202);
  assert.equal((await get("/api/jobs")).filter((job) => job.kind === "render").length, 20);
  let maxActive = 0;
  for (let attempt = 0; attempt < 1800; attempt++) {
    const summary = await get("/api/process/queue");
    maxActive = Math.max(maxActive, summary.active);
    assert.ok(summary.active <= 1);
    if (!summary.active && !summary.queued) break;
    if (attempt === 1799) throw new Error("Render batch did not drain.");
    await new Promise((r) => setTimeout(r, 50));
  }
  const final = await Promise.all(accepted.map((job) => get("/api/process/status/" + job.jobId)));
  assert.equal(maxActive, 1);
  assert.equal(final.filter((job) => job.status === "completed").length, 19, log);
  assert.equal(final.filter((job) => job.status === "failed").length, 1, log);
  const edit = final.find(job => job.jobId === "render-batch-19");
  const waitedBatch = final.find(job => job.jobId === "render-batch-18");
  assert.ok(edit.startedAt < waitedBatch.startedAt, "Interactive re-edit must advance ahead of waiting batch renders.");
  const sample = await get("/api/process/status/" + accepted[0].jobId);
  const video = await fetch(base + sample.downloadUrl, { headers });
  assert.equal(video.status, 200);
  assert.ok((await video.arrayBuffer()).byteLength > 1000);
  const metadata = await get("/api/styles");
  assert.equal(metadata.capabilities.renderQueue, 1);
  assert.equal(metadata.output.width, 1080);
  assert.equal(metadata.output.height, 1920);
});
