import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderHeadlinePng } from "./headline.js";
import { PRESETS, resolveStyle } from "./styles.js";
import { processClip } from "./process.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("hidden headlines rasterize to a fully transparent pixel, including cover boxes", async () => {
  for (const coverBox of [undefined, { xPct: 50, yPct: 20, widthPct: 90, heightPct: 10 }]) {
    const style = { ...PRESETS.boxed_red.headline, enabled: false, coverBox };
    const before = JSON.stringify(style);
    const image = renderHeadlinePng({ text: "KEEP MY HEADLINE 123", highlight: ["HEADLINE"], width: 1080, height: 1920, style });
    assert.equal(image.lines, 0);
    const canvas = createCanvas(1, 1);
    canvas.getContext("2d").drawImage(await loadImage(image.buffer), 0, 0);
    assert.equal(canvas.getContext("2d").getImageData(0, 0, 1, 1).data[3], 0);
    assert.equal(JSON.stringify(style), before);
  }
});
test("visibility survives style resolution and can be restored without changing layout", () => {
  const hidden = resolveStyle("boxed_red", { headline: { enabled: false } });
  assert.equal(hidden.headline.enabled, false);
  const shown = resolveStyle("boxed_red", { headline: { enabled: true } });
  assert.equal(shown.headline.enabled, true);
  assert.equal(shown.headline.font, hidden.headline.font);
  assert.equal(shown.caption.font, hidden.caption.font);
  assert(renderHeadlinePng({ text: "KEEP MY HEADLINE 123", highlight: [], width: 1080, height: 1920, style: shown.headline }).lines > 0);
});
test("1080p MP4 hides the headline but retains captions in fill and blurfit", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "headline-visibility-"));
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  try {
    const input = path.join(dir, "source.mp4");
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "lavfi", "-i",
      "color=c=0x334455:size=320x180:rate=30:duration=0.2", "-threads", "1", input]);
    for (const layout of ["fill", "blurfit"]) {
      const luminance = {};
      for (const enabled of [false, true]) {
        const output = path.join(dir, `${layout}-${enabled}.mp4`);
        await processClip({ inputPath: input, workDir: path.join(dir, `${layout}-${enabled}`), outputPath: output,
          headline: { text: "KEEP MY HEADLINE 123", highlight: [] },
          words: [{ word: "CAPTION", start: 0, end: 0.2 }],
          style: resolveStyle("boxed_red", { layout, headline: { enabled, autoPosition: false } }) });
        const rgb = execFileSync(ffmpeg, ["-loglevel", "error", "-ss", "0.1", "-i", output, "-frames:v", "1", "-vf",
          "crop=96:96:492:412", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
        luminance[enabled] = rgb.reduce((sum, value) => sum + value, 0) / rgb.length;
        if (!enabled) {
          const caption = execFileSync(ffmpeg, ["-loglevel", "error", "-ss", "0.1", "-i", output, "-frames:v", "1", "-vf",
            "crop=1080:700:0:1200", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 4_000_000 });
          assert(caption.some(value => value > 190), `${layout}: captions must remain visible`);
        }
      }
      assert(luminance.false < 90, `${layout}: hidden headline must leave the source intact`);
      assert(luminance.true > luminance.false + 25, `${layout}: showing the headline must restore its box`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
