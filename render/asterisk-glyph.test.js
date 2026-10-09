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
    const canvas = createCanvas(950, 840);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.font = `1200px "${family}"`;
    ctx.fillText("*", 0, 840);
    const alpha = (x, y) => ctx.getImageData(x, y, 1, 1).data[3];
    for (const [x, y] of [[299, 200], [299, 420], [299, 640], [130, 315], [470, 315], [130, 525], [470, 525]]) {
      assert.ok(alpha(x, y) > 240, `Missing asterisk arm at ${x},${y}`);
    }
    for (const [x, y] of [[20, 20], [900, 20], [20, 810], [900, 810]]) {
      assert.equal(alpha(x, y), 0, "Glyph must not include the source image background");
    }
    ctx.font = `100px "${family}"`;
    assert.ok(Math.abs(ctx.measureText("*").width - 598 / 12) < 1, "Compact original glyph advance");
    for (const letter of ["T", "C", "I", "G"]) {
      assert.ok(Math.abs(ctx.measureText(`*${letter}`).width - ctx.measureText("*").width - ctx.measureText(letter).width) < 2, "No excessive following-letter spacing");
    }
    assert.ok(Math.abs(ctx.measureText("'").width - ctx.measureText(",").width) < 1);
    assert.ok(Math.abs(ctx.measureText("’").width - ctx.measureText("'").width) < 1, "Curly apostrophe uses the same repaired glyph");
    // Removing * creates a new F/C kerning pair, so the word-width difference
    // is not necessarily the isolated glyph's advance.
    assert.ok(ctx.measureText("F*CK").width > ctx.measureText("FCK").width);
  });
}
