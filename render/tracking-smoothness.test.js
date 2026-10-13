import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { smoothFaceTrack, cameraAt, trackedForegroundGeometry } from "./face-tracking-core.js";
import { trackedLayoutFilter } from "./tracking-framing.js";
import { sourceVideoFilter } from "./video-filters.js";
const track = Array.from({ length: 51 }, (_, i) => ({ t: i / 10, x: .2 + .3 * i / 50, y: .3,
  w: .1, h: .2, confidence: .9, faceId: "face-1" }));
const tracking = { enabled: true, mode: "selectedFace", faceId: "face-1", zoom: 1.3,
  smoothness: .8, deadZonePct: 2, startSeconds: 0, endSeconds: 5, track };
const source = { cropLeftPct: 10, cropRightPct: 5, cropTopPct: 5, cropBottomPct: 0, zoom: 1.1, tracking };

test("native and browser framing follows the same focus in blurfit and fill", () => {
  for (const layout of ["blurfit", "fill"]) {
    const camera = smoothFaceTrack(tracking, 5);
    const geometry = trackedForegroundGeometry(320, 180, 180, 320, layout, source, tracking, cameraAt(camera, 2));
    const graph = trackedLayoutFilter(layout, 180, 320, 320, 180, source, {}, 2);
    assert.ok(graph.includes(`crop=${geometry.cropWidth}:${geometry.cropHeight}:${geometry.cropX}:${geometry.cropY}`));
    assert.ok(graph.includes(`scale=${geometry.foregroundWidth}:${geometry.foregroundHeight}`));
    const buffer = execFileSync("ffmpeg", ["-v","error","-threads","1","-filter_complex_threads","1",
      "-f","lavfi","-i","testsrc2=s=320x180:d=0.1","-filter_complex",graph,"-map","[base]",
      "-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","-"]);
    assert.equal(buffer.length, 180 * 320 * 3);
  }
});
test("full-height fill crop does not expose black stripes and uses dynamic source time", () => {
  const graph = trackedLayoutFilter("fill", 180, 320, 320, 180, source, {}, undefined);
  assert.match(graph, /max\(.*t/);
  assert.match(graph, /crop=180:320/);
  const buffer = execFileSync("ffmpeg", ["-v","error","-threads","1","-filter_complex_threads","1",
    "-f","lavfi","-i","color=c=red:s=320x180:r=30:d=1","-filter_complex",graph,"-map","[base]",
    "-pix_fmt","rgb24","-f","rawvideo","-"], { maxBuffer: 8 * 1024 * 1024 });
  for (let n = 0; n < 30; n++) {
    for (const offset of [0, (180*320-1)*3]) assert.ok(buffer[n*180*320*3+offset] > 200, "fill edge remains footage");
  }
});
test("RGB color pipeline supports every look and slider at the limits", () => {
  for (const settings of [{ preset: "warm" },{ preset: "cool" },{ preset: "mono" },
    { brightness: .2, contrast: 1.5, saturation: 2, sharpness: 1 },
    { brightness: -.2, contrast: .5, saturation: 0 }]) {
    const graph = sourceVideoFilter(settings);
    execFileSync("ffmpeg", ["-v","error","-threads","1","-filter_threads","1",
      "-f","lavfi","-i","testsrc2=s=320x180:d=0.1","-vf",graph.replace(/,$/,""),
      "-frames:v","1","-f","null","-"]);
  }
});
