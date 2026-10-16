import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
const run = promisify(execFile);

test("authenticated queue preserves output-time speech after pause removal and independently mixes selected sounds", { timeout: 90000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "duck-http-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
    env: { ...process.env, PORT: "0", DOWNLOAD_DIR: dir, API_KEY: "isolated-test-only",
      ENABLE_FACE_TRACKING: "0", RENDER_CACHE_DIR: path.join(dir, "cache") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", b => { log += b; });
  child.stderr.on("data", b => { log += b; });
  const files = [];
  try {
    const deadline = Date.now() + 15000;
    while (!/running on port (\d+)/.test(log) && child.exitCode === null && Date.now() < deadline)
      await new Promise(r => setTimeout(r, 50));
    const match = log.match(/running on port (\d+)/);
    assert.ok(match, log);
    const root = `http://127.0.0.1:${match[1]}`;
    const headers = { "Content-Type": "application/json", Authorization: "Bearer isolated-test-only" };
    assert.equal((await fetch(root + "/api/styles")).status, 401);
    const catalog = await (await fetch(root + "/api/styles", { headers })).json();
    assert.equal(catalog.capabilities.voiceDucking, 1);
    assert.equal((await fetch(root + "/api/process", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    const sounds = [];
    for (const frequency of [880, 1320]) {
      const assetId = randomUUID();
      const assetUrl = `https://test.replit.app/api/editing-assets/${assetId}/file`;
      const cached = path.resolve("uploads/context-assets", `${createHash("sha256").update(assetUrl).digest("hex")}.mp3`);
      files.push(cached);
      await fs.mkdir(path.dirname(cached), { recursive: true });
      await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=2`,
        "-c:a", "libmp3lame", "-y", cached]);
      sounds.push({ id: randomUUID(), assetId, assetUrl, assetDurationSeconds: 2.05,
        startSeconds: .2, trimStartSeconds: .1, durationSeconds: 1.7, volumeDb: -12, muted: false });
    }
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=160x90:r=30:d=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-threads", "1",
      "-c:a", "aac", "-shortest", "-y", path.join(dir, "source.mp4")]);
    const sourceEdit = { segments: [{ srcStart: .5, srcEnd: 1.5, speed: 1 }, { srcStart: 2, srcEnd: 3, speed: 1 }] };
    // Canonical word 2.213–2.617 projected ONCE by the app to 1.213–1.617.
    const words = [{ word: "HELLO", start: 1.213, end: 1.617 }];
    const duck = { attenuationDb: -12, attackMs: 30, releaseMs: 100, durationSeconds: .1, leadSeconds: .04 };
    const invalid = await fetch(root + "/api/process", { method: "POST", headers, body: JSON.stringify({
      jobId: "duck_invalid", clipFilename: "source.mp4", headline: "TEST", highlightWords: [], words,
      styleOverrides: { soundEffects: [{ ...sounds[0], voiceDucking: { ...duck, attenuationDb: -99 } }] },
    }) });
    assert.equal(invalid.status, 400);
    const render = async (name, selected) => {
      const payload = { jobId: name, clipFilename: "source.mp4", headline: "TEST", highlightWords: [], words, sourceEdit,
        styleOverrides: { layout: "fill", soundEffects: selected } };
      const response = await fetch(root + "/api/process", { method: "POST", headers, body: JSON.stringify(payload) });
      assert.equal(response.status, 202, await response.text());
      let job;
      for (let i = 0; i < 240; i++) {
        const status = await fetch(root + `/api/process/status/${name}`, { headers });
        assert.equal(status.status, 200);
        job = await status.json();
        if (job.status === "completed" || job.status === "failed") break;
        await new Promise(r => setTimeout(r, 150));
      }
      assert.equal(job.status, "completed", JSON.stringify(job) + log);
      assert.ok(Math.abs(job.durationSeconds - 2) < .05);
      assert.equal(job.words[0].start, words[0].start);
      const { stdout } = await run("ffmpeg", ["-v", "error", "-i", path.join(dir, job.filename),
        "-af", "aresample=async=1:first_pts=0", "-ac", "1", "-ar", "44100", "-f", "f32le", "-"],
        { encoding: "buffer", maxBuffer: 2e6 });
      return stdout;
    };
    const plain = await render("duck_plain", sounds);
    const ducked = await render("duck_selected", [{ ...sounds[0], voiceDucking: duck }, sounds[1]]);
    const amplitude = (pcm, start, frequency) => {
      let real = 0, imaginary = 0;
      // Integer cycles of all three tones avoid measuring source-voice leakage
      // as SFX energy when that SFX is attenuated by 12dB.
      const first = Math.round(start * 44100), n = 2205; // 50ms
      for (let i = first; i < first + n; i++) {
        const value = pcm.readFloatLE(i * 4);
        const phase = 2 * Math.PI * frequency * i / 44100;
        real += value * Math.cos(phase); imaginary += value * Math.sin(phase);
      }
      return Math.hypot(real, imaginary) * 2 / n;
    };
    for (const at of [1.225, 1.56]) {
      const db = 20 * Math.log10(amplitude(ducked, at, 880) / amplitude(plain, at, 880));
      assert.ok(Math.abs(db + 12) < 1, `speech boundary ${at}: ${db}dB`);
      for (const frequency of [440, 1320]) {
        const ratio = amplitude(ducked, at, frequency) / amplitude(plain, at, frequency);
        assert.ok(Math.abs(ratio - 1) < .1, `unselected/source ${frequency}: ${ratio}`);
      }
    }
    for (const at of [.4, 1.8]) {
      const ratio = amplitude(ducked, at, 880) / amplitude(plain, at, 880);
      assert.ok(Math.abs(ratio - 1) < .1, `outside speech ${at}: ${ratio}`);
    }
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise(r => child.once("exit", r));
    await Promise.all(files.map(f => fs.rm(f, { force: true })));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
