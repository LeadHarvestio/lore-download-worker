import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sourceEditClock, sourceEditDuration, sourceEditFilter, validateSourceEdit, encodeSourceEdit } from "./source-edit.js";
const run = promisify(execFile);

test("40 fractional shots have a global, not per-shot frame/sample budget", () => {
  const edit = validateSourceEdit({ segments: Array.from({ length: 40 }, (_, i) =>
    ({ srcStart: i * 2 + .013, srcEnd: i * 2 + 1.132, speed: [.25, .5, 1, 1.5, 2, 4][i % 6] })) }, 81);
  const clock = sourceEditClock(edit), duration = sourceEditDuration(edit);
  assert.equal(clock.reduce((n, s) => n + s.frames, 0), Math.round(duration * 30));
  assert.equal(clock.reduce((n, s) => n + s.samples, 0), Math.round(duration * 44100));
  let time = 0, frames = 0, samples = 0;
  edit.segments.forEach((s, i) => {
    time += (s.srcEnd - s.srcStart) / s.speed;
    frames += clock[i].frames; samples += clock[i].samples;
    assert(Math.abs(frames / 30 - time) <= 1 / 60 + 1e-10);
    assert(Math.abs(samples / 44100 - time) <= 1 / 88200 + 1e-10);
  });
  const graph = sourceEditFilter(edit, true);
  assert(!graph.includes(":v=1:a=1"), "never let video concat pad the audio clock");
  assert(graph.includes(":v=0:a=1,asetpts=N/SR/TB"));
});

test("sub-frame shots consume audio samples without forcing extra video frames", () => {
  const edit = validateSourceEdit({ segments: [{ srcStart: 0, srcEnd: 1 },
    { srcStart: 2, srcEnd: 2.001 }, { srcStart: 3, srcEnd: 4 }] }, 4);
  assert.equal(sourceEditClock(edit)[1].frames, 0);
  assert.equal(sourceEditClock(edit)[1].samples, 44);
  assert(sourceEditFilter(edit, false).includes("[vin1]nullsink"));
  assert(!sourceEditFilter(edit, false).includes("[0:a]"));
  assert(sourceEditFilter(edit, true).includes("concat=n=3:v=0:a=1"));
});

test("encoded 40-cut media obeys cumulative frame/sample budgets, including tempo changes", { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cut-clock-"));
  try {
    const source = path.join(dir, "source.mp4"), output = path.join(dir, "cut.mp4");
    await run("ffmpeg", ["-y", "-v", "error", "-threads", "1", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=17",
      "-f", "lavfi", "-i", "anoisesrc=seed=123:duration=17:amplitude=0.2", "-c:v", "libx264", "-threads", "1",
      "-preset", "ultrafast", "-c:a", "aac", "-shortest", source], { timeout: 20000 });
    const edit = validateSourceEdit({ segments: Array.from({ length: 40 }, (_, i) =>
      ({ srcStart: i * .4 + .013, srcEnd: i * .4 + .332, speed: [.25, .5, 1, 1.5, 2, 4][i % 6] })) }, 17);
    await encodeSourceEdit(source, output, edit, true);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", output]);
    const streams = JSON.parse(stdout).streams;
    const v = streams.find(s => s.codec_type === "video"), a = streams.find(s => s.codec_type === "audio");
    const duration = sourceEditDuration(edit);
    assert.equal(Number(v.nb_frames), Math.round(duration * 30));
    // MP4's audio duration_ts is in the 44.1kHz sample timebase.
    assert.equal(a.time_base, "1/44100");
    // MP4's millisecond edit-list rounding can differ by up to 1 ms, but must
    // not grow with segment count or with separately rounded video frames.
    assert(Math.abs(Number(a.duration_ts) - Math.round(duration * 44100)) <= 45);
    assert(Math.abs(Number(v.duration) - duration) <= 1 / 60 + 1e-6);
    const decoded = await run("ffmpeg", ["-v", "error", "-i", output, "-vn", "-af", "aresample=async=1:first_pts=0",
      "-ar", "44100", "-ac", "1", "-f", "s16le", "-"], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
    // Decoded AAC may include one final codec packet of padding, not 40 pads.
    assert(Math.abs(decoded.stdout.length / 2 - Math.round(duration * 44100)) <= 1024);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
