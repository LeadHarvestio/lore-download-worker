import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { validateStyleInput } from "../video-processor.js";
import { resolveStyle } from "./styles.js";
import { directorLayoutFilter, sourcePlaneRects } from "./director-layout.js";
import { directorForegroundGeometry, nameTagPosition } from "./director-geometry.js";
import { prepareStackedCreative } from "./stacked-creative.js";
import { prepareNameTags } from "./name-tags.js";
import { processClip } from "./process.js";

const id = "11111111-1111-4111-8111-111111111111";
export const track = (faceId = "known", x = .35) => ({
  enabled: true, mode: "selectedFace", zoom: 1.1, smoothness: .7, deadZonePct: 4,
  faceId, startSeconds: 0, endSeconds: 2,
  track: Array.from({ length: 21 }, (_, i) => ({ t: i / 10, x: x + i / 500, y: .35, w: .12, h: .2, confidence: .95, faceId })),
});
const tag = () => ({ id, text: "CREATOR'S %{NAME}: [A]", color: "#FF49D7", startSeconds: .2, endSeconds: 1, tracking: track() });
const run = (args, options = {}) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-threads", "1", ...args], {
  timeout: 120000, maxBuffer: 30 * 1024 * 1024, ...options,
});
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "director-layout-"));
function fixture(dir, sw = 640, sh = 360) {
  const c = createCanvas(sw, sh), ctx = c.getContext("2d");
  ctx.fillStyle = "#e82020"; ctx.fillRect(0, 0, sw / 2, sh);
  ctx.fillStyle = "#2040e8"; ctx.fillRect(sw / 2, 0, sw / 2, sh);
  ctx.fillStyle = "#ffe000"; ctx.fillRect(0, 0, sw, sh * .08);
  fs.writeFileSync(path.join(dir, "source.png"), c.toBuffer("image/png"));
  const source = path.join(dir, "source.mp4");
  run(["-loop", "1", "-i", path.join(dir, "source.png"), "-t", "2", "-r", "30", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-threads", "1", source]);
  return source;
}
async function decoded(file, at) {
  const png = run(["-ss", String(at), "-i", file, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-threads", "1", "-"]);
  const image = await loadImage(png), c = createCanvas(image.width, image.height), ctx = c.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return { pixel: (x, y) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data], ctx, width: image.width, height: image.height };
}
function encode(dir, source, graph, name, args = [], label = "base", duration = 1.4) {
  const script = path.join(dir, `${name}.txt`), output = path.join(dir, `${name}.mp4`);
  fs.writeFileSync(script, graph);
  run(["-filter_complex_threads", "1", "-i", source, ...args, "-filter_complex_script", script, "-map", `[${label}]`,
    "-t", String(duration), "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "14", "-pix_fmt", "yuv420p", "-threads", "1", output]);
  return output;
}
const red = p => p[0] > 190 && p[1] < 70 && p[2] < 70;
const green = p => p[1] > 180 && p[0] < 70 && p[2] < 70;

test("wire validation rejects malformed panes, guessed identities and tags over three output seconds", () => {
  validateStyleInput("boxed_red", { sourcePanes: { topPct: 58, top: { mode: "fill", tracking: track() }, bottom: { mode: "blurfit" } }, nameTags: [tag()] });
  for (const overrides of [
    { sourcePanes: { topPct: 80, top: { mode: "fill" }, bottom: { mode: "blurfit" } } },
    { sourcePanes: { topPct: 58, top: { mode: "stretch" }, bottom: { mode: "blurfit" } } },
    { nameTags: [{ ...tag(), endSeconds: 3.3 }] },
    { nameTags: [{ ...tag(), text: " " }] },
    { nameTags: [{ ...tag(), tracking: { ...track(), faceId: undefined } }] },
    { nameTags: [{ ...tag(), tracking: { ...track(), mode: "autoFace" } }] },
    { nameTags: [{ ...tag(), tracking: { ...track(), track: [] } }] },
    { nameTags: [{ ...tag(), tracking: { ...track(), faceId: "other" } }] },
    { nameTags: Array.from({ length: 5 }, tag) },
  ]) assert.throws(() => validateStyleInput("boxed_red", overrides));
  assert.equal(resolveStyle("boxed_red").sourcePanes, undefined, "legacy defaults must not opt in");
});

test("decoded portrait/landscape panes preserve cropped sharp geometry in fill and blurfit", async () => {
  const dir = temp();
  try {
    for (const [sw, sh] of [[640, 360], [360, 640]]) {
      const source = fixture(dir, sw, sh);
      for (const mode of ["fill", "blurfit"]) {
        const style = resolveStyle("boxed_red", { source: { cropTopPct: 12, cropLeftPct: 8, cropRightPct: 4, zoom: 1.2, xPct: 45, yPct: 55 },
          sourcePanes: { topPct: 58, top: { mode }, bottom: { mode, tracking: track("right", .64) } } });
        const output = encode(dir, source, directorLayoutFilter(style, 216, 384, sw, sh, style.source), `${sw}-${mode}`);
        const frame = await decoded(output, .4), top = 222;
        // Compare sharp pixels against the same Canvas geometry used by preview.
        for (const [key, py, ph] of [["top", 0, top], ["bottom", top, 384 - top]]) {
          const { tracking: _ignored, ...manual } = style.source;
          const g = directorForegroundGeometry(sw, sh, 216, ph, mode, { ...manual, ...(style.sourcePanes[key].tracking ? { tracking: style.sourcePanes[key].tracking } : {}) }, [], .4);
          for (const fx of [.25, .75]) {
            const x = g.foregroundX + g.foregroundWidth * fx, y = py + g.foregroundY + g.foregroundHeight * .5;
            if (x < 8 || x > 208 || y < py + 8 || y > py + ph - 8) continue;
            const sx = g.cropX + g.cropWidth * fx, p = frame.pixel(x, y);
            assert.ok(sx < sw / 2 ? red(p) : p[2] > 180 && p[0] < 70, `${sw} ${mode} ${key}: ${p}`);
          }
        }
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("both sharp pane masks restore source above under-video layers and honor cut transforms", async () => {
  const dir = temp();
  try {
    const source = fixture(dir), c = createCanvas(216, 384), ctx = c.getContext("2d");
    ctx.fillStyle = "#00ff00"; ctx.fillRect(0, 0, 216, 384);
    const image = path.join(dir, "green.png"); fs.writeFileSync(image, c.toBuffer("image/png"));
    const edit = { segments: [{ srcStart: 0, srcEnd: .5, speed: 1, transform: { yPct: 25 } }, { srcStart: 1, srcEnd: 2, speed: 1, transform: { yPct: 75 } }] };
    const layer = { id, assetId: id, kind: "image", mode: "overlay", placement: "under-video", startSeconds: 0, endSeconds: 2, xPct: 50, yPct: 50, widthPct: 100, heightPct: 100, trimStartSeconds: 0 };
    const style = resolveStyle("boxed_red", { layers: [layer], sourcePanes: { topPct: 50, top: { mode: "blurfit" }, bottom: { mode: "blurfit" } } });
    const args = [];
    const creative = await prepareStackedCreative({ style, args, nextIndex: 1, width: 216, height: 384, duration: 1.5,
      sourceWidth: 640, sourceHeight: 360, source: style.source, sourceEdit: edit, workDir: dir }, async () => image);
    const output = encode(dir, source, [directorLayoutFilter(style, 216, 384, 640, 360, style.source, edit), ...creative.filters].join(";"),
      "stack", args, creative.label);
    for (const at of [.2, .8]) {
      const frame = await decoded(output, at);
      for (const rect of sourcePlaneRects(style, 640, 360, 216, 384, edit, at)) {
        assert.ok(red(frame.pixel(70, rect.y + rect.h / 2)), "sharp source must cover lower green image in each pane");
        const outsideY = at < .5 ? rect.y + rect.h + 12 : rect.y - 12;
        assert.ok(green(frame.pixel(70, outsideY)), `context outside sharp at ${at} ${JSON.stringify(rect)}: ${frame.pixel(70, outsideY)}`);
      }
    }
    style.layers.push({ ...layer, id: "22222222-2222-4222-8222-222222222222", placement: "over-video", widthPct: 100, heightPct: 100 });
    const overArgs = [];
    const over = await prepareStackedCreative({ style, args: overArgs, nextIndex: 1, width: 216, height: 384, duration: 1.5,
      sourceWidth: 640, sourceHeight: 360, source: style.source, sourceEdit: edit, workDir: dir }, async () => image);
    const overFile = encode(dir, source, [directorLayoutFilter(style, 216, 384, 640, 360, style.source, edit), ...over.filters].join(";"), "over", overArgs, over.label);
    assert.ok(green((await decoded(overFile, .2)).pixel(70, 80)), "above-video layer covers sharp pane");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("name text and arrows move with selected cached face and hide at half-open ends in decoded MP4", async () => {
  const dir = temp();
  try {
    const source = fixture(dir);
    const style = resolveStyle("boxed_red", { layout: "blurfit", headline: { enabled: false }, nameTags: [tag()],
      sourcePanes: { topPct: 58, top: { mode: "fill" }, bottom: { mode: "blurfit" } } });
    const args = [], width = 1080, height = 1920;
    const tags = prepareNameTags({ style, args, nextIndex: 1, width, height, sw: 640, sh: 360, duration: 1.4, workDir: dir, label: "base" });
    const output = encode(dir, source, [directorLayoutFilter(style, width, height, 640, 360, style.source), ...tags.filters].join(";"), "tags", args, tags.label);
    function pinkCount(frame, position) {
      const region = frame.ctx.getImageData(position.x - 180, position.y - 12, 360, 160).data;
      let count = 0;
      for (let n = 0; n < region.length; n += 4) if (region[n] > 180 && region[n + 1] < 140 && region[n + 2] > 140) count++;
      return count;
    }
    const pos = nameTagPosition(tag(), style, 640, 360, width, height, .4);
    assert.ok(pos);
    assert.ok(pinkCount(await decoded(output, .4), pos) > 150, "creator text/arrow must be visible at projected position");
    const laterPos = nameTagPosition(tag(), style, 640, 360, width, height, .8);
    assert.ok(laterPos.x > pos.x + 5, "label follows only the explicitly selected moving face");
    const pinkX = frame => {
      const data = frame.ctx.getImageData(0, 0, width, height).data;
      let count = 0, sum = 0;
      for (let n = 0; n < data.length; n += 4) if (data[n] > 180 && data[n + 1] < 140 && data[n + 2] > 140) {
        count++; sum += (n / 4) % width;
      }
      return sum / count;
    };
    const actualMove = pinkX(await decoded(output, .8)) - pinkX(await decoded(output, .4));
    assert.ok(Math.abs(actualMove - (laterPos.x - pos.x)) < 3, "decoded label movement agrees with cached face coordinates");
    assert.equal(pinkCount(await decoded(output, .1), pos), 0, "hidden before start");
    assert.equal(pinkCount(await decoded(output, 1), pos), 0, "hidden at end");
    assert.equal(nameTagPosition({ ...tag(), tracking: { ...track(), track: [] } }, style, 640, 360, width, height, .4), null);
    assert.equal(nameTagPosition({ ...tag(), tracking: { ...track(), track: [{ ...track().track[0], t: 0 }] } }, style, 640, 360, width, height, .9), null, "stale detections hide");
    const cropped = { ...style, source: { cropTopPct: 40 } };
    assert.equal(nameTagPosition({ ...tag(), tracking: { ...track(), track: track().track.map(p => ({ ...p, y: .05 })) } }, cropped, 640, 360, width, height, .4), null, "cropped away face hides");
    // Full active processClip chain, including two-stage composition and tag input indices.
    const final = path.join(dir, "active.mp4"), preview = path.join(dir, "preview.png");
    const params = { inputPath: source, workDir: path.join(dir, "work"), headline: { text: "TEST", highlight: [] }, words: [], style,
      sourceEdit: { segments: [{ srcStart: .5, srcEnd: 1, speed: .5 }, { srcStart: 1.5, srcEnd: 2, speed: 1 }] } };
    await processClip({ ...params, outputPath: final });
    await processClip({ ...params, outputPath: preview, previewAt: .4 });
    assert.ok(pinkCount(await decoded(final, .4), pos) > 150);
    const img = await loadImage(preview), c = createCanvas(width, height), ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
    assert.ok(pinkCount({ ctx }, pos) > 150, "native preview matches final projected label");
    assert.equal((await decoded(final, .4)).width, 1080);
    if (process.env.DIRECTOR_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.DIRECTOR_EVIDENCE_DIR, { recursive: true });
      fs.copyFileSync(preview, path.join(process.env.DIRECTOR_EVIDENCE_DIR, "native-preview.png"));
      fs.writeFileSync(path.join(process.env.DIRECTOR_EVIDENCE_DIR, "decoded-export.png"),
        run(["-ss", "0.4", "-i", final, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-threads", "1", "-"]));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
