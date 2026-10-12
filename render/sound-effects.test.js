import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareSoundEffects } from "./sound-effects.js";
import { processClip, resolveStyle } from "./process.js";
import { createHash, randomUUID } from "node:crypto";
const run = promisify(execFile);
const id = "11111111-1111-4111-8111-111111111111";
const effect = { id, assetId: id, startSeconds: .5, trimStartSeconds: .2, durationSeconds: .4,
  assetDurationSeconds: 1, volumeDb: -6, muted: false };
test("sound inputs are independently trimmed, gained, delayed and padded", async () => {
  const args = [];
  const result = await prepareSoundEffects({ effects: [effect], args, nextIndex: 3, duration: 2 }, async e => {
    assert.equal(e.kind, "audio"); return "/tmp/boom.mp3";
  });
  assert.deepEqual(args, ["-i", "/tmp/boom.mp3"]);
  assert.equal(result.nextIndex, 4);
  assert.match(result.filters[0], /\[3:a\].*atrim=start=0.2:duration=0.4.*volume=-6dB.*adelay=500:all=1.*atrim=duration=2/);
});
test("muted, static preview and out-of-range instances never fetch audio", async () => {
  const resolver = async () => { throw Error("Should not fetch"); };
  for (const options of [{ effects: [{ ...effect, muted: true }] }, { effects: [effect], preview: true },
    { effects: [{ ...effect, startSeconds: 10 }] }]) {
    const r = await prepareSoundEffects({ args: [], nextIndex: 0, duration: 2, ...options }, resolver);
    assert.deepEqual(r.labels, []);
  }
});
test("rejects duplicate identities and trims beyond the asset", async () => {
  await assert.rejects(prepareSoundEffects({ effects: [effect, effect], args: [], nextIndex: 0, duration: 2 }, async () => "/tmp/test"));
  await assert.rejects(prepareSoundEffects({ effects: [{ ...effect, durationSeconds: 2 }], args: [], nextIndex: 0, duration: 2 }));
});
test("real encoded audio is silent before/after placement and audible during the chosen interval", { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-export-"));
  try {
    const tone = path.join(dir, "tone.wav"), out = path.join(dir, "export.m4a");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=1", "-y", tone], { timeout: 20000 });
    const args = ["-v", "error", "-filter_complex_threads", "1"];
    const prepared = await prepareSoundEffects({ effects: [effect], args, nextIndex: 0, duration: 1.5 }, async () => tone);
    args.push("-filter_complex", prepared.filters.join(";"), "-map", `[${prepared.labels[0]}]`, "-t", "1.5", "-c:a", "aac", "-y", out);
    await run("ffmpeg", args, { timeout: 20000 });
    // AAC can coalesce silent packets. Reconstruct their timestamps rather than
    // treating the decoded sample array as if every packet had equal duration.
    const { stdout: pcm } = await run("ffmpeg", ["-v", "error", "-i", out,
      "-af", "aresample=async=1:first_pts=0", "-f", "f32le", "-ac", "1", "-ar", "44100", "-"],
      { encoding: "buffer", timeout: 15000 });
    const rms = async (start, length) => {
      let sum = 0, samples = 0;
      for (let i = Math.floor(start * 44100) * 4; i < Math.floor((start + length) * 44100) * 4 && i + 4 <= pcm.length; i += 4) {
        sum += pcm.readFloatLE(i) ** 2; samples++;
      }
      assert.ok(samples > 0);
      return Math.sqrt(sum / samples);
    };
    assert.ok(await rms(.1, .15) < .001);
    assert.ok(await rms(.6, .15) > .01);
    assert.ok(await rms(1.1, .15) < .001);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("full native export retains added sound when the original voice is muted", { timeout: 90000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-full-export-"));
  const assetId = randomUUID(), assetUrl = `https://test.replit.app/api/editing-assets/${assetId}/file`;
  const cacheFile = path.resolve("uploads/context-assets", `${createHash("sha256").update(assetUrl).digest("hex")}.mp3`);
  try {
    const main = path.join(dir, "source.mp4"), out = path.join(dir, "finished.mp4");
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=1", "-c:a", "libmp3lame", cacheFile], { timeout: 20000 });
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=160x90:r=30:d=1.2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2", "-c:v", "libx264", "-threads", "1", "-c:a", "aac", "-shortest", main], { timeout: 20000 });
    const style = resolveStyle("boxed_red", { source: { muteAudio: true },
      soundEffects: [{ ...effect, id: assetId, assetId, assetUrl, startSeconds: .3, trimStartSeconds: 0, durationSeconds: .6 }] });
    await processClip({ inputPath: main, outputPath: out, workDir: path.join(dir, "work"),
      headline: { text: "SOUND TEST", highlight: [] }, words: [], style });
    const { stdout } = await run("ffmpeg", ["-v", "error", "-i", out, "-af", "aresample=async=1:first_pts=0",
      "-ac", "1", "-ar", "44100", "-f", "f32le", "-"], { encoding: "buffer", timeout: 20000 });
    let sum = 0, count = 0;
    for (let i = Math.floor(.45 * 44100) * 4; i < Math.floor(.6 * 44100) * 4; i += 4) { sum += stdout.readFloatLE(i) ** 2; count++; }
    assert.ok(Math.sqrt(sum / count) > .01, "muting the original must not silence the added sound");
    let silent = 0;
    for (let i = Math.floor(.05 * 44100) * 4; i < Math.floor(.15 * 44100) * 4; i += 4) silent += stdout.readFloatLE(i) ** 2;
    assert.ok(Math.sqrt(silent / (.1 * 44100)) < .001, "muted source must remain silent before added sound");
  } finally { await fs.rm(dir, { recursive: true, force: true }); await fs.rm(cacheFile, { force: true }); }
});
