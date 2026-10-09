import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { processVideo, cleanProvidedWords, normalizeWords, toRenderWords } from "./video-processor.js";
import { censorWords } from "./render/censorship.js";
import { buildAss } from "./render/captions.js";
import { resolveStyle } from "./render/styles.js";

const run = promisify(execFile);
test("keeps word colors and line breaks through normalization and censorship", () => {
  const input = [{ word: "fuck", start: .1, end: .8, color: "#19E3F2", breakBefore: true }];
  const result = toRenderWords(censorWords(normalizeWords(cleanProvidedWords(input), 1)));
  assert.deepEqual(result, [{ word: "f*ck", start: .1, end: .8, color: "#19E3F2", breakBefore: true }]);
  assert.equal(input[0].word, "fuck");
  assert.equal(cleanProvidedWords([{ word: "x", color: "invalid" }])[0].color, undefined);
});

test("exports colorful censored captions into an actual MP4 without transcription", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caption-export-"));
  try {
    const input = path.join(dir, "input.mp4"), output = path.join(dir, "output.mp4"), frame = path.join(dir, "frame.png");
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=black:s=360x640:r=30:d=1", "-pix_fmt", "yuv420p", input]);
    await processVideo({
      jobId: "color-export", clipPath: input, outputPath: output, headline: "TEST",
      highlightWords: [], words: [{ word: "fuck", start: .1, end: .9, color: "#19E3F2" }],
      censorCaptions: true, muteExpletives: false,
      styleOverrides: { caption: { pop: false, animation: "none", shadowBlurPct: .1, glow: { enabled: true, sizePct: .2, blurPct: .8 } } },
      transcribeWords: async () => { throw Error("Cached words must not trigger transcription"); },
    });
    await run("ffmpeg", ["-y", "-ss", "0.5", "-i", output, "-frames:v", "1", frame]);
    const image = await loadImage(frame), canvas = createCanvas(image.width, image.height), ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
    let cyan = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 1] > 140 && pixels[i + 2] > 140) cyan++;
    assert.ok(cyan > 300, `Expected encoded cyan caption pixels, found ${cyan}`);
    if (process.env.CAPTION_EXPORT_PROOF) {
      fs.mkdirSync(path.dirname(process.env.CAPTION_EXPORT_PROOF), { recursive: true });
      fs.copyFileSync(frame, process.env.CAPTION_EXPORT_PROOF);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("blurs only the separate shadow layer, keeping the main letters crisp", () => {
  const style = resolveStyle("boxed_red", { caption: { animation: "none", blurPct: 0, shadowBlurPct: .1 } });
  const ass = buildAss({ words: [{ word: "hello", start: 0, end: 1, color: "#19E3F2" }], width: 1080, height: 1920, style: style.caption });
  assert.match(ass, /Dialogue: 1,.*\\blur1\.08/);
  assert.match(ass, /Dialogue: 2,.*\\blur0.*\\shad0/);
});

test("exports apostrophes, quotation marks and dashes in a real MP4", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "punctuation-export-"));
  try {
    const input = path.join(dir, "input.mp4"), output = path.join(dir, "output.mp4");
    const phrases = ["IT'S IT’S I'M", '"GO" “GO”', "GO-TO GO–TO GO—TO", "D*MN."];
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=black:s=360x640:r=30:d=1", "-pix_fmt", "yuv420p", input]);
    await processVideo({
      jobId: "punctuation-export", clipPath: input, outputPath: output, headline: "FONT CHECK",
      highlightWords: [], censorCaptions: false, muteExpletives: false,
      words: phrases.map((word, i) => ({
        word, start: i * .25, end: i * .25 + .24, color: "#19E3F2", breakBefore: true,
      })),
      styleOverrides: { caption: {
        font: "Integral CF Extra Bold", yPct: 50, sizePct: 8, maxCharsPerChunk: 48,
        pop: false, animation: "none", shadowBlurPct: .1, glow: { enabled: true, sizePct: .2, blurPct: .8 },
      } },
      transcribeWords: async () => { throw Error("Punctuation check must not run transcription"); },
    });
    let montage, montageCtx;
    for (let i = 0; i < phrases.length; i++) {
      const frame = path.join(dir, `frame-${i}.png`);
      await run("ffmpeg", ["-y", "-ss", String(i * .25 + .12), "-i", output, "-frames:v", "1", frame]);
      const image = await loadImage(frame);
      montage ??= createCanvas(image.width * 2, 560);
      montageCtx ??= montage.getContext("2d");
      const cropped = createCanvas(image.width, 280), ctx = cropped.getContext("2d");
      ctx.drawImage(image, 0, image.height / 2 - 140, image.width, 280, 0, 0, image.width, 280);
      const pixels = ctx.getImageData(0, 0, image.width, 280).data;
      let cyan = 0;
      for (let p = 0; p < pixels.length; p += 4) if (pixels[p] < 100 && pixels[p + 1] > 140 && pixels[p + 2] > 140) cyan++;
      assert.ok(cyan > 200, `Missing encoded caption for ${phrases[i]}`);
      montageCtx.drawImage(cropped, (i % 2) * image.width, Math.floor(i / 2) * 280);
    }
    if (process.env.PUNCTUATION_EXPORT_PROOF) {
      fs.mkdirSync(path.dirname(process.env.PUNCTUATION_EXPORT_PROOF), { recursive: true });
      fs.writeFileSync(process.env.PUNCTUATION_EXPORT_PROOF, montage.toBuffer("image/png"));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
