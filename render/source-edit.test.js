import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateSourceEdit, tempoChain, encodeSourceEdit } from "./source-edit.js";
const run = promisify(execFile);

test("strict segment validation and chained audio tempo", () => {
  assert.equal(tempoChain(.25), "atempo=0.5,atempo=0.5");
  assert.equal(tempoChain(4), "atempo=2,atempo=2");
  for (const segments of [[], [{ srcStart: 1, srcEnd: 0 }], [{ srcStart: 0, srcEnd: 2 }, { srcStart: 1, srcEnd: 3 }], [{ srcStart: 0, srcEnd: 4 }], [{ srcStart: 0, srcEnd: 1, speed: 5 }], [{ srcStart: 0, srcEnd: 1, url: "bad" }]]) {
    assert.throws(() => validateSourceEdit({ segments }, 3));
  }
  assert.deepEqual(validateSourceEdit({ segments: [{ srcStart: 0, srcEnd: 1 }] }, 3).segments[0], { srcStart: 0, srcEnd: 1, speed: 1 });
});
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "source-edit-test-"));
  const source = path.join(dir, "source.mp4");
  await run("ffmpeg", ["-y", "-v", "error", "-threads", "1", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=880:duration=3", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", source]);
  return { dir, source };
}
async function streams(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
  return JSON.parse(stdout);
}
for (const [name, segments, expected] of [
  ["single segment", [{ srcStart: .3, srcEnd: 1.3 }], 1],
  ["two segments with a removed gap", [{ srcStart: 0, srcEnd: .6 }, { srcStart: 1.2, srcEnd: 1.8 }], 1.2],
  ["2x speed keeps video and audio synchronized", [{ srcStart: 0, srcEnd: 3, speed: 2 }], 1.5],
  ["0.25x chained tempo", [{ srcStart: 0, srcEnd: .5, speed: .25 }], 2],
]) {
  test(name, { timeout: 30000 }, async () => {
    const { dir, source } = await fixture();
    try {
      const out = path.join(dir, "out.mp4");
      await encodeSourceEdit(source, out, validateSourceEdit({ segments }, 3), true);
      const data = await streams(out);
      assert.ok(Math.abs(Number(data.format.duration) - expected) < .09);
      const v = data.streams.find(stream => stream.codec_type === "video"), a = data.streams.find(stream => stream.codec_type === "audio");
      assert.ok(Math.abs(Number(v.duration) - Number(a.duration)) < 1 / 30 + .001, "stream durations stay within one output frame");
      const { stdout } = await run("ffmpeg", ["-v", "error", "-i", out, "-af", "aresample=async=1:first_pts=0", "-ac", "1", "-ar", "8000", "-f", "f32le", "-"], { encoding: "buffer" });
      let power = 0;
      for (let i = 0; i < stdout.length; i += 4) power += stdout.readFloatLE(i) ** 2;
      assert.ok(Math.sqrt(power / (stdout.length / 4)) > .01, "source audio remains audible");
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
}
test("full cut render accepts output-time captions beyond original duration", { timeout: 60000 }, async () => {
  const { dir, source } = await fixture();
  const oldCache = process.env.RENDER_CACHE_DIR;
  process.env.RENDER_CACHE_DIR = path.join(dir, "cache");
  try {
    const { processVideo } = await import("../video-processor.js");
    const result = await processVideo({ jobId: "source-edit-export", clipPath: source, outputPath: path.join(dir, "final.mp4"),
      headline: "TEST", highlightWords: [], words: [{ word: "KEPT", start: 3.5, end: 3.9 }],
      sourceEdit: { segments: [{ srcStart: 0, srcEnd: 2, speed: .5 }] }, styleOverrides: { layout: "fill", source: { muteAudio: false } },
      transcribeWords: () => { throw new Error("Must not re-transcribe"); },
    });
    assert.ok(Math.abs(result.durationSeconds - 4) < .1);
    assert.equal(result.captionWordCount, 1);
    assert.match(await fs.readFile(result.srtPath, "utf8"), /00:00:03,500/);
    assert.equal(result.outputWidth, 1080);
    assert.equal(result.outputHeight, 1920);
  } finally {
    if (oldCache === undefined) delete process.env.RENDER_CACHE_DIR; else process.env.RENDER_CACHE_DIR = oldCache;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
