import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("authenticated live recipe and bundled fonts work without any source or FFmpeg", { timeout: 15000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-live-preview-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const worker = spawn(process.execPath, ["server.js"], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, PORT: "0", API_KEY: "local-live-preview-key", DOWNLOAD_DIR: directory, FFMPEG_BIN: "/does-not-exist" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  worker.stdout.on("data", data => { log += data; });
  worker.stderr.on("data", data => { log += data; });
  t.after(async () => { worker.kill(); await Promise.race([once(worker, "exit"), new Promise(r => setTimeout(r, 3000))]); });
  let base;
  for (let attempt = 0; attempt < 100 && !base; attempt++) {
    const match = log.match(/Download worker running on port (\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    await new Promise(r => setTimeout(r, 30));
  }
  assert.ok(base, log);
  const headers = { Authorization: "Bearer local-live-preview-key", "Content-Type": "application/json" };
  const payload = { headline: "A TEST HEADLINE", censorCaptions: true, words: [{ word: "fuck", start: .4, end: .8 }] };
  assert.equal((await fetch(base + "/api/live-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).status, 401);
  const response = await fetch(base + "/api/live-preview", { method: "POST", headers, body: JSON.stringify(payload) });
  assert.equal(response.status, 200);
  const recipe = await response.json();
  assert.equal(recipe.caption.cues[0].words[0].text, "F*CK");
  assert.equal(recipe.transcriptAvailable, true);
  assert.equal(recipe.muteRanges.length, 1);
  assert.equal(recipe.width, 1080); assert.equal(recipe.height, 1920);
  const font = await fetch(base + "/api/styles/fonts/Archivo%20Black", { headers });
  assert.equal(font.status, 200);
  assert.ok((await font.arrayBuffer()).byteLength > 10000);
  assert.equal((await fetch(base + "/api/styles/fonts/toString", { headers })).status, 404);
  assert.equal((await fetch(base + "/api/jobs", { headers })).status, 200);
  const jobs = await (await fetch(base + "/api/jobs", { headers })).json();
  assert.deepEqual(jobs, [], "Live editing must not create background render jobs.");
  const bad = await fetch(base + "/api/live-preview", { method: "POST", headers, body: JSON.stringify({ ...payload, words: [{ word: "oops", start: 1, end: 0 }] }) });
  assert.equal(bad.status, 400);
});
