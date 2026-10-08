import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("HTTP batch of 20 advances automatically with two download slots and survives a bad video", { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-download-queue-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, "fixture.mp4");
  execFileSync(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:size=160x90:rate=15:duration=0.4", "-threads", "1", fixture]);
  const video = fs.readFileSync(fixture);
  let active = 0, maximum = 0;
  const assets = createServer((req, res) => {
    active++; maximum = Math.max(maximum, active);
    let counted = true;
    res.on("close", () => { if (counted) { active--; counted = false; } });
    setTimeout(() => {
      res.writeHead(req.url === "/3.mp4" ? 503 : 200, { "Content-Type": "video/mp4" });
      res.end(req.url === "/3.mp4" ? "Temporarily unavailable" : video);
    }, 200);
  });
  assets.listen(0, "127.0.0.1"); await once(assets, "listening");
  t.after(() => new Promise((resolve) => assets.close(resolve)));
  const worker = spawn(process.execPath, ["server.js"], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, PORT: "0", API_KEY: "local-queue-fixture-key", DOWNLOAD_DIR: path.join(dir, "downloads") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  worker.stdout.on("data", (chunk) => { log += chunk; });
  worker.stderr.on("data", (chunk) => { log += chunk; });
  t.after(async () => { worker.kill(); await Promise.race([once(worker, "exit"), new Promise((r) => setTimeout(r, 3000))]); });
  // PORT=0 selects an available OS port; discover it from the actual bound address.
  let base;
  for (let attempt = 0; attempt < 100 && !base; attempt++) {
    const match = log.match(/Download worker running on port (\d+)/);
    if (match && match[1] !== "0") base = `http://127.0.0.1:${match[1]}`;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.ok(base, log);
  const headers = { Authorization: "Bearer local-queue-fixture-key", "Content-Type": "application/json" };
  const accepted = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    const response = await fetch(base + "/api/download", { method: "POST", headers, body: JSON.stringify({ assetId: `batch-${index}`, sourceUrl: `http://127.0.0.1:${assets.address().port}/${index}.mp4` }) });
    assert.equal(response.status, 200);
    return response.json();
  }));
  const initial = await Promise.all(accepted.map(async (job) => (await fetch(base + "/api/status/" + job.jobId, { headers })).json()));
  assert.ok(initial.some((job) => job.status === "queued"));
  const final = await Promise.all(accepted.map(async (job) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const state = await (await fetch(base + "/api/status/" + job.jobId, { headers })).json();
      if (state.status === "completed" || state.status === "failed") return state;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Batch did not drain.");
  }));
  assert.equal(maximum, 2);
  assert.equal(final.filter((job) => job.status === "completed").length, 19);
  assert.equal(final.filter((job) => job.status === "failed").length, 1);
  assert.match(final.find((job) => job.status === "failed").error, /503/);
});
