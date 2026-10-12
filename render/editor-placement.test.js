import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { sourceSettings, layoutFilter } from "./framing.js";
import { resolveStyle, PRESETS } from "./styles.js";
import { renderHeadlinePng } from "./headline.js";
import { processClip } from "./process.js";

test("position normalizes to center; both axes validate without changing old catalog defaults", () => {
  assert.equal(sourceSettings().xPct, 50);
  for (const invalid of [{ xPct: -1 }, { yPct: 101 }, { xPct: NaN }]) assert.throws(() => sourceSettings(invalid));
  assert.match(layoutFilter("blurfit", 1080, 1920, 320, 180, { xPct: 60, yPct: 30 }), /x=W\*0.6-w\/2:y=H\*0.3-h\/2/);
  assert.match(layoutFilter("fill", 1080, 1920, 320, 180, { yPct: 30 }), /shortest=1/);
  assert.equal(PRESETS.boxed_red.source.xPct, undefined, "old clients can consume catalog defaults");
});

test("cover backing exactly fills its bounds and long text fits without transparent corners", async () => {
  const style = resolveStyle("boxed_red", { headline: { coverBox: { xPct: 70, yPct: 85, widthPct: 40, heightPct: 8 } } });
  const headline = renderHeadlinePng({ text: "A VERY LONG REPLACEMENT HEADLINE THAT MUST FIT", highlight: ["REPLACEMENT"], width: 1080, height: 1920, style: style.headline });
  assert.equal(headline.width, 432);
  assert.equal(headline.height, 154);
  const image = await loadImage(headline.buffer), canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
  for (const [x, y] of [[0, 0], [431, 0], [0, 153], [431, 153]]) assert.deepEqual([...ctx.getImageData(x, y, 1, 1).data], [255, 255, 255, 255]);
  assert.ok(headline.fontSize > 0);
  const glow = renderHeadlinePng({ text: "WHITE TEXT REMAINS VISIBLE", highlight: [], width: 1080, height: 1920,
    style: resolveStyle("glow_magenta", { headline: { coverBox: style.headline.coverBox } }).headline });
  const glowImage = await loadImage(glow.buffer); ctx.drawImage(glowImage, 0, 0);
  assert.deepEqual([...ctx.getImageData(0, 0, 1, 1).data], [16, 17, 21, 255], "boxless white text gets contrasting backing");
});

test("native decoded frames move the foreground, preserve blur and put cover on the requested region", { timeout: 90000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "worker-editor-position-"));
  try {
    const inputPath = path.join(dir, "source.mp4");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x205090:s=320x180:r=30:d=0.4", "-threads", "1", inputPath]);
    async function frame(name, source, coverBox) {
      const outputPath = path.join(dir, `${name}.png`);
      await processClip({ inputPath, outputPath, workDir: path.join(dir, name), previewAt: .1,
        headline: { text: "CHECK THIS HEADLINE", highlight: [] }, words: [],
        style: resolveStyle("boxed_red", { source, headline: { autoPosition: false, yPct: 10, ...(coverBox ? { coverBox } : {}) } }) });
      const image = await loadImage(outputPath), canvas = createCanvas(image.width, image.height), ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      return (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
    }
    const before = await frame("before", {});
    const moved = await frame("moved", { xPct: 70, yPct: 20 });
    assert.notDeepEqual(before(540, 1100), moved(540, 1100), "sharp video moves away from old position");
    assert.deepEqual(before(10, 1800), moved(10, 1800), "background stays fixed");
    const cover = await frame("cover", {}, { xPct: 70, yPct: 85, widthPct: 40, heightPct: 8 });
    assert.ok(cover(545, 1558)[0] > 240, "cover begins at requested left/top edge");
    assert.notDeepEqual(cover(539, 1558), cover(545, 1558), "cover begins at its requested edge, not the frame center");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("finished MP4 retains repositioning and cover bounds at 1080p/30fps", { timeout: 90000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "worker-editor-export-"));
  try {
    const clipPath = path.join(dir, "source.mp4"), outputPath = path.join(dir, "finished.mp4");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x205090:s=320x180:r=30:d=0.4", "-threads", "1", clipPath]);
    const { processVideo } = await import("../video-processor.js");
    await processVideo({ jobId: "position-cover-export", clipPath, outputPath, headline: "REPLACEMENT HEADLINE",
      highlightWords: ["REPLACEMENT"], words: [{ word: "f*ck", start: 0, end: .4, color: "#19E3F2" }],
      styleOverrides: { source: { xPct: 50, yPct: 20, cropLeftPct: 5, cropRightPct: 5, zoom: 1.3 },
        headline: { coverBox: { xPct: 75, yPct: 80, widthPct: 30, heightPct: 10 } } } });
    const meta = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", outputPath]).toString()).streams[0];
    assert.deepEqual(meta, { width: 1080, height: 1920, r_frame_rate: "30/1" });
    const png = execFileSync("ffmpeg", ["-v", "error", "-ss", "0.2", "-i", outputPath, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]);
    const image = await loadImage(png), canvas = createCanvas(image.width, image.height), ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
    const pixel = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
    assert.ok(pixel(650, 1442)[0] > 235, "cover at correct source-frame coordinates");
    assert.ok(pixel(640, 1442)[0] < 150, "cover does not extend beyond its bounds");
    assert.notDeepEqual(pixel(540, 400), pixel(540, 1100), "foreground moved above its old center");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
