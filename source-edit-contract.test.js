import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test("sourceEdit capability and strict HTTP 400 contract", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "source-edit-api-"));
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const child = spawn(process.execPath, ["server.js"], { cwd: path.dirname(new URL(import.meta.url).pathname), env: {
    ...process.env, PORT: String(port), DOWNLOAD_DIR: directory, RENDER_CACHE_DIR: path.join(directory, "cache"), API_KEY: "source-contract-fixture",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stderr.on("data", data => { output += data.toString(); });
  const headers = { Authorization: "Bearer source-contract-fixture", "Content-Type": "application/json" };
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${origin}/health`)).ok) break; } catch {}
      if (child.exitCode !== null) throw new Error(output);
      await pause(100);
    }
    const catalog = await fetch(`${origin}/api/styles`, { headers }).then(r => r.json());
    assert.equal(catalog.capabilities.sourceEdit, 1);
    assert.equal(catalog.output.width, 1080);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=30:d=1", "-threads", "1", path.join(directory, "source.mp4")]);
    const request = sourceEdit => fetch(`${origin}/api/process`, { method: "POST", headers, body: JSON.stringify({
      jobId: "source-contract", clipFilename: "source.mp4",
      headline: "ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE TEN ELEVEN TWELVE",
      highlightWords: "ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE TEN ELEVEN TWELVE".split(" "),
      words: [], sourceEdit,
    }) });
    for (const segments of [[{ srcStart: 0, srcEnd: 1.2 }], [{ srcStart: 0, srcEnd: .7 }, { srcStart: .6, srcEnd: .9 }], [{ srcStart: .5, srcEnd: .4 }], [{ srcStart: 0, srcEnd: .8, speed: 5 }]]) {
      const result = await request({ segments });
      const error = await result.json();
      assert.equal(result.status, 400, JSON.stringify(error));
      assert.match(error.error, /Source segments/);
    }
    const accepted = await request({ segments: [{ srcStart: 0, srcEnd: 1, speed: 2 }] });
    assert.equal(accepted.status, 202, await accepted.text());
    let job;
    for (let i = 0; i < 150; i++) {
      job = await fetch(`${origin}/api/process/status/source-contract`, { headers }).then(r => r.json());
      if (job.status === "completed" || job.status === "failed") break;
      await pause(100);
    }
    assert.equal(job.status, "completed", job.error || output);
    const meta = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_format", "-of", "json", path.join(directory, job.filename)]).toString());
    assert.ok(Math.abs(Number(meta.format.duration) - .5) < .1);
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
