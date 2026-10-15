import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareSoundEffects } from "./sound-effects.js";
import { speechDuckingFilter, voiceDuckingSchema } from "./voice-ducking.js";
import { processVideo } from "../video-processor.js";
const run = promisify(execFile);
export const duck = { attenuationDb: -12, attackMs: 30, releaseMs: 100, durationSeconds: .1, leadSeconds: .04 };
const id = "11111111-1111-4111-8111-111111111111";
const sound = { id, assetId: id, startSeconds: .2, trimStartSeconds: .1, durationSeconds: 1.7,
  assetDurationSeconds: 2, volumeDb: -6, muted: false };
const words = [{ word: "hello", start: .713, end: 1.117 }];
test("strict opt-in schema, missing timing, empty timing, and no speech placeholders", async () => {
  for (const value of [null, true, { ...duck, attenuationDb: -20 }, { ...duck, attackMs: 0 },
    { ...duck, releaseMs: 501 }, { ...duck, leadSeconds: .2 }, { ...duck, durationSeconds: 2 },
    { ...duck, unknown: true }]) assert.equal(voiceDuckingSchema.safeParse(value).success, false);
  assert.equal(speechDuckingFilter(undefined, undefined, 0, 2), "");
  assert.throws(() => speechDuckingFilter(duck, undefined, 0, 2), /saved output-time/);
  assert.equal(speechDuckingFilter(duck, [], 0, 2), "");
  assert.equal(speechDuckingFilter(duck, [{ word: "[music]", start: .5, end: 1 }], 0, 2), "");
  let transcribed = false;
  await assert.rejects(processVideo({ styleOverrides: { soundEffects: [{ ...sound, voiceDucking: duck }] },
    transcribeWords: async () => { transcribed = true; return []; } }), /no automatic transcription/);
  assert.equal(transcribed, false);
});

test("decoded AAC preserves trims and level, ducks speech boundaries, and leaves overlapping plain effects alone", { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "duck-audio-"));
  try {
    const tone = path.join(dir, "tone.wav");
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=2", "-y", tone]);
    const encode = async (effects, speech = words) => {
      const args = ["-v", "error", "-filter_complex_threads", "1"];
      const prepared = await prepareSoundEffects({ effects, args, nextIndex: 0, duration: 2, words: speech }, async () => tone);
      const filters = [...prepared.filters, `${prepared.labels.map(l => `[${l}]`).join("")}amix=inputs=${prepared.labels.length}:normalize=0[out]`];
      const file = path.join(dir, `${Math.random()}.m4a`);
      await run("ffmpeg", [...args, "-filter_complex", filters.join(";"), "-map", "[out]", "-c:a", "aac", "-y", file]);
      const { stdout } = await run("ffmpeg", ["-v", "error", "-i", file, "-af", "aresample=async=1:first_pts=0",
        "-f", "f32le", "-ac", "1", "-ar", "44100", "-"], { encoding: "buffer", maxBuffer: 2e6 });
      return stdout;
    };
    const rms = (pcm, start, end) => {
      let sum = 0, count = 0;
      for (let i = Math.round(start * 44100) * 4; i < Math.round(end * 44100) * 4 && i + 4 <= pcm.length; i += 4) {
        sum += pcm.readFloatLE(i) ** 2; count++;
      }
      assert.ok(count > 0);
      return Math.sqrt(sum / count);
    };
    const plain = await encode([sound]);
    const ducked = await encode([{ ...sound, voiceDucking: duck }]);
    const empty = await encode([{ ...sound, voiceDucking: duck }], []);
    const overlap = await encode([{ ...sound, voiceDucking: duck }, { ...sound, id: "22222222-2222-4222-8222-222222222222" }]);
    const repeated = await encode([{ ...sound, voiceDucking: duck }], [...words, ...words]);
    for (const [start, end] of [[.72, .75], [.9, 1], [1.085, 1.11]]) {
      const ratio = rms(ducked, start, end) / rms(plain, start, end);
      assert.ok(Math.abs(20 * Math.log10(ratio) + 12) < .8, `speech ${start}: ${ratio}`);
      assert.ok(Math.abs(rms(repeated, start, end) / rms(ducked, start, end) - 1) < .05);
      assert.ok(Math.abs(rms(overlap, start, end) / rms(plain, start, end) - (1 + 10 ** (-12 / 20))) < .08);
    }
    for (const [start, end] of [[.3, .4], [1.3, 1.4]]) {
      assert.ok(Math.abs(rms(ducked, start, end) / rms(plain, start, end) - 1) < .05);
      assert.ok(Math.abs(rms(empty, start, end) / rms(plain, start, end) - 1) < .05);
    }
    // Both sides of the attack and release, at non-frame-aligned word times.
    assert.ok(rms(ducked, .65, .67) > rms(ducked, .68, .70));
    assert.ok(rms(ducked, 1.12, 1.14) < rms(ducked, 1.19, 1.21));
    assert.ok(rms(ducked, .03, .1) < .001);
    assert.ok(rms(ducked, 1.95, 1.99) < .001);
    await assert.rejects(prepareSoundEffects({ effects: [{ ...sound, trimStartSeconds: 1.5,
      durationSeconds: 1, assetDurationSeconds: 20 }], args: [], nextIndex: 0, duration: 2 }, async () => tone), /actual saved audio/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
