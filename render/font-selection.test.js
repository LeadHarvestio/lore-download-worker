import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { buildAss } from "./captions.js";
import { FONTS, resolveStyle } from "./styles.js";
const fontsDir = fileURLToPath(new URL("../fonts/", import.meta.url));

for (const [name, font] of Object.entries(FONTS).filter(([name]) => name.startsWith("Integral CF"))) {
  test(`${name} asterisk matches capital height without excessive advance`, () => {
    const alias = `Glyph regression ${name}`;
    assert.ok(GlobalFonts.registerFromPath(path.join(fontsDir, font.file), alias));
    const ctx = createCanvas(600, 150).getContext("2d");
    ctx.font = `100px "${alias}"`;
    const star = ctx.measureText("*");
    const letter = ctx.measureText("N");
    const height = m => m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    assert.ok(Math.abs(height(star) - height(letter)) <= 1,
      `Star height ${height(star)} does not match capital height ${height(letter)}`);
    assert.ok(star.width <= letter.width * 1.1 && star.width >= letter.width * .7,
      `Star advance ${star.width} is disproportionate to letter advance ${letter.width}`);
  });
  test(`FFmpeg uses the bundled ${name} face, not a substitute font`, async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "caption-font-"));
    try {
      const file = path.join(folder, "sample.ass");
      const style = { ...resolveStyle("boxed_red").caption, font: name };
      const ass = buildAss({ words: [{ word: "CAPTION", start: 0, end: .2 }], width: 1080, height: 1920, style });
      assert.ok(ass.includes(`Style: Default,${font.assFamily},`));
      await fs.writeFile(file, ass);
      const result = spawnSync("ffmpeg", ["-hide_banner", "-f", "lavfi", "-i", "color=c=black:s=1080x1920:d=0.15",
        "-vf", `ass=${file}:fontsdir=${fontsDir}`, "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8", timeout: 20000 });
      assert.equal(result.status, 0, result.stderr);
      const selected = result.stderr.split("\n").filter(line => line.includes("fontselect:"));
      assert.ok(selected.some(line => line.split("->")[1]?.includes(font.assFamily)), selected.join("\n"));
      assert.ok(!selected.some(line => /DejaVu|Liberation|Arial/i.test(line.split("->")[1] || "")), selected.join("\n"));
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  });
}
