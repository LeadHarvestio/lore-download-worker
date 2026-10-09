import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderHeadlinePng } from "./headline.js";
import { resolveStyle } from "./styles.js";
import { headlinePosition, previewWords } from "./placement.js";
import { buildAss } from "./captions.js";
import { processClip } from "./process.js";

test("reference headline is two tight stepped lines using actual glyph bounds", () => {
  const style = resolveStyle("boxed_red");
  const h = renderHeadlinePng({ text: "DR. UMAR SEEMINGLY EXPLAINS REGGIE'S ALLEGATIONS AGAINST KAI CENAT",
    highlight: ["DR. UMAR", "REGGIE'S", "KAI CENAT"], width: 1080, height: 1920, style: style.headline });
  assert.equal(h.lines, 2);
  assert.ok(h.lineAdvance - h.inkHeight < 6);
  assert.ok(h.visibleBox.height < 195);
  assert.equal(style.headline.box.fitLines, true);
});

test("automatic headline does not overlap the sharp landscape source", () => {
  const style = resolveStyle("boxed_red");
  const h = { width: 1000, height: 300, visibleBox: { x: 65, y: 65, width: 870, height: 170 } };
  const y = headlinePosition({ sourceWidth: 1920, sourceHeight: 1080, width: 1080, height: 1920, headline: h, style });
  const sourceTop = (1920 - 1080 * (1080 / 1920)) / 2;
  assert.ok(y + h.visibleBox.y >= 0);
  assert.ok(y + h.visibleBox.y + h.visibleBox.height < sourceTop);
});

test("manual positioning is honored and portrait auto falls back to the top edge", () => {
  const h = { width: 1000, height: 300, visibleBox: { x: 65, y: 65, width: 870, height: 170 } };
  const style = resolveStyle("boxed_red", { headline: { yPct: 60 } });
  assert.equal(style.headline.autoPosition, false);
  const args = { sourceWidth: 1080, sourceHeight: 1920, width: 1080, height: 1920, headline: h, style };
  assert.equal(headlinePosition(args), 1920 * .6 - 150);
  const y = headlinePosition({ ...args, style: resolveStyle("boxed_red") });
  assert.equal(y + h.visibleBox.y, 27);
});

test("preview captions use the selected source time without reviving past words", () => {
  const words = [{ word: "EARLIER", start: .2, end: .5 }, { word: "F*CK", start: 2.2, end: 2.8 }];
  const shifted = previewWords(words, 2.4);
  assert.equal(words[1].start, 2.2);
  const ass = buildAss({ words: shifted, width: 1080, height: 1920, style: resolveStyle("boxed_red").caption });
  const events = ass.split("\n").filter(s => s.startsWith("Dialogue:"));
  assert.equal(events.length, 2); // matching halo and sharp Integral fill
  for (const event of events) {
    assert.match(event, /F\*CK/);
    assert.match(event, /0:00:00\.00,0:00:00\.58/);
    assert.doesNotMatch(event, /EARLIER/);
  }
});

test("concurrent synthetic PNG previews draw the selected caption without filter-thread errors", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "layout-regression-"));
  try {
    const source = path.join(dir, "source.mp4");
    execFileSync(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi",
      "-i", "color=c=0x223344:size=320x180:rate=5:duration=4", "-threads", "1", source]);
    const style = resolveStyle("boxed_red");
    const outputs = await Promise.all([true, false].map(async captions => {
      const work = path.join(dir, captions ? "caption" : "blank");
      const out = path.join(dir, captions ? "caption.png" : "blank.png");
      await processClip({ inputPath: source, outputPath: out, workDir: work,
        headline: { text: "SYNTHETIC TEST", highlight: [] }, style, previewAt: 2.4,
        words: captions ? [{ word: "VISIBLE", start: 2.2, end: 2.8 }] : [] });
      const image = await loadImage(out);
      const c = createCanvas(1080, 1920);
      c.getContext("2d").drawImage(image, 0, 0);
      return c.getContext("2d").getImageData(0, Math.round(1920 * style.caption.yPct / 100) - 150, 1080, 300).data;
    }));
    assert.notDeepEqual(outputs[0], outputs[1], "Caption must change the actual PNG pixels");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
