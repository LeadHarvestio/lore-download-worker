import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { transcriptionAudio } from "./transcription-audio.js";

test("real source audio extracts bounded, complete WAV; longer clips are partial and silence fails explicitly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-audio-"));
  try {
    for (const seconds of [1, 61]) {
      const input = path.join(dir, `source-${seconds}.mp4`);
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=32x32:r=1", "-f", "lavfi", "-i", "sine=frequency=440", "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-y", input]);
      const result = await transcriptionAudio(input);
      assert.equal(result.complete, seconds <= 60);
      assert.ok(result.sampleDuration > Math.min(seconds, 60) - 0.1 && result.sampleDuration <= 60);
      assert.ok(result.audio.length <= 2 * 1024 * 1024);
      assert.equal(result.audio.toString("ascii", 0, 4), "RIFF");
      assert.equal(result.audio.readUInt32LE(4), result.audio.length - 8);
      const wav = path.join(dir, `${seconds}.wav`); fs.writeFileSync(wav, result.audio);
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", wav], { encoding: "utf8" }));
      assert.equal(probe.streams[0].channels, 1);
      assert.equal(probe.streams[0].sample_rate, "16000");
      assert.equal(probe.streams[0].codec_name, "pcm_s16le");
      assert.ok(Math.abs(Number(probe.format.duration) - result.sampleDuration) < 0.001);
    }
    const silent = path.join(dir, "no-audio.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=32x32:r=1", "-t", "1", "-c:v", "libx264", "-y", silent]);
    await assert.rejects(transcriptionAudio(silent));
    const delayed = path.join(dir, "delayed.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=blue:s=32x32:r=1", "-itsoffset", "1", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-y", delayed]);
    const aligned = await transcriptionAudio(delayed);
    const alignedFile = path.join(dir, "aligned.wav"); fs.writeFileSync(alignedFile, aligned.audio);
    const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", alignedFile, "-f", "f32le", "pipe:1"], { maxBuffer: 1024 * 1024 });
    const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
    const rms = (start, end) => Math.sqrt(samples.slice(start * 16000, end * 16000).reduce((sum, v) => sum + v * v, 0) / ((end - start) * 16000));
    assert.ok(rms(0, 0.5) < 1e-6, "Leading silence must preserve video-relative word and censor timestamps");
    assert.ok(rms(1.3, 1.8) > 0.005);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
