import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

const fontsDir = fileURLToPath(new URL("../fonts/", import.meta.url));
const files = readdirSync(fontsDir).filter(file => /^IntegralCF-.+\.otf$/.test(file));
assert.equal(files.length, 6, "All six Integral CF weights must be bundled");

for (const file of files) {
  test(`${file}: a literal asterisk renders the supplied six-point star`, () => {
    const family = `Asterisk regression ${file}`;
    assert.ok(GlobalFonts.registerFromPath(`${fontsDir}/${file}`, family));
    const canvas = createCanvas(950, 1400);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.font = `1200px "${family}"`;
    ctx.fillText("*", 0, 1200);
    const alpha = (x, y) => ctx.getImageData(x, y, 1, 1).data[3];
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let left = canvas.width, right = 0, top = canvas.height, bottom = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      if (pixels[(y * canvas.width + x) * 4 + 3] > 240) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
    }
    assert.ok(bottom - top > 500, "Full-height glyph, not a demo icon");
    // The repaired full-cap-height glyph has different absolute bounds than
    // the early short-star fixture. Test six arms relative to its ink bounds.
    for (const [fx, fy] of [[.5, .15], [.5, .5], [.5, .85], [.18, .32], [.82, .32], [.18, .68], [.82, .68]]) {
      const x = Math.round(left + (right - left) * fx), y = Math.round(top + (bottom - top) * fy);
      assert.ok(alpha(x, y) > 240, `Missing asterisk arm at ${x},${y}`);
    }
    for (const [x, y] of [[20, 20], [900, 20], [20, 1390], [900, 1390]]) {
      assert.equal(alpha(x, y), 0, "Glyph must not include the source image background");
    }
    ctx.font = `100px "${family}"`;
    assert.ok(ctx.measureText("*").width > ctx.measureText("H").width * .5 &&
      ctx.measureText("*").width < ctx.measureText("H").width * 1.1, "Full-height star fits the uppercase letter advance");
    for (const letter of ["T", "C", "I", "G"]) {
      assert.ok(Math.abs(ctx.measureText(`*${letter}`).width - ctx.measureText("*").width - ctx.measureText(letter).width) < 2, "No excessive following-letter spacing");
    }
    assert.ok(ctx.measureText("'").width > 0 && ctx.measureText("'").width < ctx.measureText("H").width * .5,
      "The repositioned apostrophe keeps a compact advance; it need not match the separate comma");
    assert.ok(Math.abs(ctx.measureText("’").width - ctx.measureText("'").width) < 1, "Curly apostrophe uses the same repaired glyph");
    // Removing * creates a new F/C kerning pair, so the word-width difference
    // is not necessarily the isolated glyph's advance.
    assert.ok(ctx.measureText("F*CK").width > ctx.measureText("FCK").width);
  });
}
