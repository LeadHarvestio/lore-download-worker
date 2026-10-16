import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { effectSchema } from "./motion-effects.js";
import { flashOpacity, zoomScale } from "./director-motion.js";
import { directorLayoutFilter, sourcePlaneRects } from "./director-layout.js";
import { segmentFramingFilter } from "./segment-framing.js";
import { sourceSettings } from "./framing.js";
import { validateSourceEdit } from "./source-edit.js";
import { validateStyleInput } from "../video-processor.js";
import { prepareCreativeInputs } from "./creative.js";
const zoom = { type: "zoom", startSeconds: .2, endSeconds: 1.2, fromScale: 1, toScale: 1.12,
  easing: "easeOut", anchor: { x: .5, y: .35 } };
const flash = { type: "flash", color: "#19FF4A", opacity: .6, startSeconds: .2, endSeconds: .4,
  blend: "screen", envelope: { attack: 1/6, hold: 1/3, decay: 1/2 } };
const ffmpeg = args => execFileSync("ffmpeg", ["-v", "error", "-filter_complex_threads", "1", ...args], { maxBuffer: 32e6 });
test("additive wire schemas reject malformed motion without defaulting legacy values", () => {
  for (const e of [{ ...zoom, toScale: 5 }, { ...flash, envelope: { attack: 1, hold: 1, decay: 1 } },
    { ...zoom, anchor: { x: NaN, y: .5 } }, { ...flash, type: "shake" }, { ...zoom, easing: undefined }]) {
    assert.equal(effectSchema.safeParse(e).success, false);
    assert.throws(() => validateStyleInput("boxed_red", { effects: [e] }));
  }
  assert.throws(() => validateSourceEdit({ segments: [{ srcStart: 0, srcEnd: 1, punchScale: 3 }] }));
  assert.equal(effectSchema.parse({ type: "flash", startSeconds: 0, endSeconds: 1 }).blend, undefined);
  const s = sourceSettings();
  assert.equal(directorLayoutFilter({ layout: "blurfit" }, 108, 192, 320, 180, s),
    segmentFramingFilter("blurfit", 108, 192, 320, 180, s));
  const legacy = { type: "flash", startSeconds: 0, endSeconds: 1, color: "#00FF00", opacity: .25 };
  assert.deepEqual(effectSchema.parse(legacy), legacy);
});
test("decoded blend channels and every envelope boundary match the preview formula", async () => {
  const size = 64*64*3;
  const input = ["-f", "lavfi", "-i", "color=c=0x805040:s=64x64:r=30:d=0.5"];
  const raw = ["-pix_fmt", "rgb24", "-f", "rawvideo", "-"];
  const baseline = ffmpeg([...input, "-vf", "format=gbrp,format=rgb24", ...raw]);
  for (const blend of ["normal", "screen", "overlay", "multiply"]) {
    for (const envelope of [undefined, flash.envelope]) {
      const e = { ...flash, blend, envelope };
      const graph = await prepareCreativeInputs({ style: { effects: [e] }, args: [], nextIndex: 1, width: 64, height: 64, duration: .5 });
      const rgb = ffmpeg([...input, "-filter_complex", ["[0:v]format=gbrp[base]", ...graph.filters].join(";"),
        "-map", `[${graph.label}]`, ...raw]);
      assert.equal(rgb.length, baseline.length);
      for (let frame = 0; frame < 15; frame++) {
        const alpha = flashOpacity(e, frame/30), index = frame*size+(32*64+32)*3;
        for (let c = 0; c < 3; c++) {
          const a = baseline[index+c], b = [25,255,74][c];
          const value = blend === "normal" ? b : blend === "screen" ? 255-(255-a)*(255-b)/255 :
            blend === "multiply" ? a*b/255 : a < 128 ? 2*a*b/255 : 255-2*(255-a)*(255-b)/255;
          assert.ok(Math.abs(rgb[index+c] - (a*(1-alpha)+value*alpha)) < 5, `${blend} envelope=${!!envelope} frame=${frame}`);
        }
      }
    }
  }
});
test("zoom easing holds, overlap precedence, cut punch geometry and half-open reset", () => {
  for (const easing of ["linear", "easeOut", "easeInOut"]) {
    const e = { ...zoom, easing };
    assert.equal(zoomScale(e, .1), 1);
    assert.equal(zoomScale(e, .45), 1.12);
    assert.equal(zoomScale(e, 1.2), 1);
    assert.ok(zoomScale(e, .3) > 1 && zoomScale(e, .3) < 1.12);
  }
  const s = { layout: "blurfit", source: sourceSettings() };
  const edit = { segments: [{ srcStart: 1, srcEnd: 2, speed: 2 }, { srcStart: 3, srcEnd: 4.5, punchScale: 1.1 }] };
  const base = sourcePlaneRects(s, 640, 360, 216, 384, edit, .4)[0];
  assert.ok(sourcePlaneRects(s, 640, 360, 216, 384, edit, .5)[0].h > base.h);
  const e = { ...zoom, toScale: 1.3 }, last = { ...zoom, toScale: 1.05 };
  assert.deepEqual(sourcePlaneRects({ ...s, effects: [e, last] }, 640, 360, 216, 384, undefined, .7),
    sourcePlaneRects({ ...s, effects: [last] }, 640, 360, 216, 384, undefined, .7));
});
test("blended flashes follow flicker regardless of array order, without reordering legacy effects", async () => {
  const flicker = { type: "flicker", startSeconds: 0, endSeconds: 1, speedHz: 1, amount: .03, glow: .2 };
  const prepare = effects => prepareCreativeInputs({ style: { effects }, args: [], nextIndex: 1, width: 64, height: 64, duration: 1 });
  assert.deepEqual((await prepare([flash,flicker])).filters, (await prepare([flicker,flash])).filters);
  const legacy = { type: "flash", startSeconds: 0, endSeconds: 1, color: "#00FF00", opacity: .25 };
  const graph = (await prepare([legacy,flicker])).filters.join(";");
  assert.ok(graph.indexOf("drawbox=x=0") < graph.indexOf("blend@flicker"), "legacy flash order is unchanged");
});
test("animated native framing executes with output-clock cut origins and manual overrides", () => {
  const punches = { segments: Array.from({ length: 12 }, (_, i) => ({
    srcStart: i*2, srcEnd: i*2+2, ...(i%2 ? { punchScale: 1.1 } : {}),
  })) };
  const punchGraph = directorLayoutFilter({ layout: "fill" }, 108, 192, 320, 180, sourceSettings(), punches);
  assert.ok(!punchGraph.includes("manualin"), "punches must not allocate a full-resolution branch per cut");
  for (const layout of ["fill", "blurfit"]) {
    const edit = { segments: [{ srcStart: 1, srcEnd: 2, speed: 2 },
      { srcStart: 3, srcEnd: 4.5, punchScale: 1.1, transform: { xPct: 55, zoom: 1.1 } }] };
    const graph = directorLayoutFilter({ layout, effects: [zoom] }, 108, 192, 320, 180, sourceSettings(), edit);
    assert.ok(graph.includes("(t+0.5)"), "trimmed framing clock retains its output offset");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=2", "-filter_complex", graph,
      "-map", "[base]", "-t", "2", "-f", "null", "-"]);
  }
});
