import test from "node:test";
import assert from "node:assert/strict";
import { renderHeadlinePng } from "./headline.js";
import { PRESETS } from "./styles.js";
const text = "Yera makes it way too obvious she's falling for N3on";
test("cover fit preserves readable font and all text without raster scaling", () => {
  const style = structuredClone(PRESETS.boxed_red.headline);
  const result = renderHeadlinePng({ text, highlight: ["Yera", "N3on"], width: 1080, height: 1920,
    style: { ...style, coverBox: { xPct: 50, yPct: 22, widthPct: 81, heightPct: 9,
      bands: [{ x: 0, y: 0, width: 1, height: .6 }, { x: .2, y: .4, width: .6, height: .6 }] } } });
  assert.equal(result.width, 1080); assert.equal(result.height, 1920);
  assert(result.fontSize >= 1080 * style.sizePct / 100 * .68);
  assert.equal(result.lines, 2);
  assert.deepEqual(style, PRESETS.boxed_red.headline);
});
test("rejects malformed or out-of-bounds cover contours", () => {
  const style = structuredClone(PRESETS.boxed_red.headline);
  assert.throws(() => renderHeadlinePng({ text, highlight: [], width: 1080, height: 1920,
    style: { ...style, coverBox: { xPct: 50, yPct: 22, widthPct: 81, heightPct: 9,
      bands: [{ x: .8, y: 0, width: .6, height: 1 }] } } }), /bands/);
});
test("uncovered headlines still use the existing compact renderer", () => {
  const result = renderHeadlinePng({ text, highlight: ["Yera"], width: 1080, height: 1920, style: PRESETS.boxed_red.headline });
  assert(result.buffer.length > 0); assert(result.width < 1080);
});
