import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { videoFilterSettings, sourceVideoFilter, VIDEO_FILTER_PRESETS } from "./video-filters.js";
import { layoutFilter } from "./framing.js";
import { processClip, resolveStyle } from "./process.js";

test("looks are bounded, no-op by default, and only filter the main source branch", () => {
  assert.equal(sourceVideoFilter(), "");
  for (const preset of Object.keys(VIDEO_FILTER_PRESETS)) {
    assert.equal(sourceVideoFilter({ preset, strength: 0 }), "");
    assert.doesNotThrow(() => sourceVideoFilter({ preset }));
  }
  for (const bad of [{ preset: "unknown" }, { strength: NaN }, { brightness: .3 }, { sharpness: -1 }, { script: true }])
    assert.throws(() => videoFilterSettings(bad));
  const filter = layoutFilter("blurfit", 1080, 1920, 320, 180, {}, { preset: "mono" });
  assert.match(filter, /\[vb\]eq=.*saturation=0/);
  assert.doesNotMatch(filter.split(";").find(s => s.startsWith("[va]")), /saturation=0/);
  assert.throws(() => resolveStyle("boxed_red", { musicStartSeconds: Infinity }));
  for (const preset of Object.keys(VIDEO_FILTER_PRESETS)) {
    execFileSync("ffmpeg", ["-v", "error", "-threads", "1", "-filter_complex_threads", "1",
      "-f", "lavfi", "-i", "testsrc2=s=320x180:d=0.1", "-filter_complex",
      layoutFilter("fill", 320, 180, 320, 180, {}, { preset }), "-map", "[base]", "-frames:v", "1", "-f", "null", "-"]);
  }
});

test("decoded native frame filters the main footage, not the blur or colored captions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "worker-video-look-"));
  try {
    const input = path.join(dir, "source.mp4"), output = path.join(dir, "look.png");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0xBC3040:s=320x180:r=30:d=1", "-threads", "1", input]);
    await processClip({ inputPath: input, outputPath: output, workDir: path.join(dir, "work"), previewAt: .2,
      headline: { text: "VIDEO LOOK", highlight: ["LOOK"] },
      words: [{ word: "COLOR", start: 0, end: 1, color: "#19E3F2" }],
      style: resolveStyle("boxed_red", { videoFilter: { preset: "mono" }, caption: { yPct: 75 } }) });
    const image = await loadImage(readFileSync(output)), canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
    const pixel = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
    const main = pixel(540, 960), blur = pixel(10, 1800);
    assert.ok(Math.max(...main.slice(0, 3)) - Math.min(...main.slice(0, 3)) < 4, "foreground is grayscale");
    assert.ok(blur[0] - blur[1] > 30, "blur retains original color");
    const region = ctx.getImageData(150, 1350, 780, 200).data;
    let cyan = 0;
    for (let i = 0; i < region.length; i += 4) if (region[i + 1] > 150 && region[i + 2] > 150 && region[i] < 100) cyan++;
    assert.ok(cyan > 100, "caption color was not filtered");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("actual 1080p export loops the chosen song section and offsets invalidate only the music cache", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "worker-music-start-"));
  try {
    const input = path.join(dir, "source.mp4"), music = path.join(dir, "song.wav");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0x203040:s=320x180:r=30:d=1.2", "-threads", "1", input]);
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.25",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=0.25", "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[a]", "-map", "[a]",
      "-metadata", `comment=${path.basename(dir)}`, music]);
    const common = { inputPath: input, musicPath: music, headline: { text: "MUSIC TEST", highlight: [] }, words: [] };
    const style = resolveStyle("boxed_red", { musicStartSeconds: .25 });
    const output = path.join(dir, "chosen.mp4");
    await processClip({ ...common, style, outputPath: output, workDir: path.join(dir, "first") });
    const meta = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", output]).toString()).streams[0];
    assert.deepEqual(meta, { width: 1080, height: 1920, r_frame_rate: "30/1" });
    const pcm = execFileSync("ffmpeg", ["-v", "error", "-ss", "0.65", "-i", output, "-t", "0.3",
      "-map", "0:a:0", "-ac", "1", "-ar", "44100", "-f", "f32le", "-"]);
    function energy(freq) {
      let sin = 0, cos = 0;
      for (let i = 0; i < pcm.length / 4; i++) {
        const sample = pcm.readFloatLE(i * 4), phase = 2 * Math.PI * freq * i / 44100;
        sin += sample * Math.sin(phase); cos += sample * Math.cos(phase);
      }
      return sin * sin + cos * cos;
    }
    assert.ok(energy(880) > energy(440) * 20, "loop does not reintroduce skipped 440Hz intro");
    const replay = await processClip({ ...common, style, outputPath: path.join(dir, "repeat.mp4"), workDir: path.join(dir, "repeat") });
    assert.equal(replay.renderStats.cacheHits.music, true);
    assert.equal(replay.renderStats.cacheHits.background, true);
    const changed = await processClip({ ...common, style: resolveStyle("boxed_red", { musicStartSeconds: 0 }),
      outputPath: path.join(dir, "start.mp4"), workDir: path.join(dir, "start") });
    assert.equal(changed.renderStats.cacheHits.music, false);
    assert.equal(changed.renderStats.cacheHits.background, true);
    await assert.rejects(processClip({ ...common, style: resolveStyle("boxed_red", { musicStartSeconds: 5 }),
      outputPath: path.join(dir, "bad.mp4"), workDir: path.join(dir, "bad") }), /beyond the end/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
