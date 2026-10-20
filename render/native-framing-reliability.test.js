import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { renderFailureDetail } from "./render-errors.js";

// Run against an assembled checkout of the exact worker branch, not old local
// renderer copies: WORKER_TEST_ROOT=/path/to/worker node --test this-file.js
const root = process.env.WORKER_TEST_ROOT || (fs.existsSync(path.resolve("render/director-layout.js"))
  ? process.cwd() : path.resolve("generated-artifacts/render-reliability/worker-main"));
const { directorLayoutFilter } = await import(pathToFileURL(path.join(root, "render/director-layout.js")));
const { sourceSettings } = await import(pathToFileURL(path.join(root, "render/framing.js")));

test("child failures retain actionable diagnostics without dumping commands", () => {
  assert.match(renderFailureDetail({ signal: "SIGKILL", message: "ffmpeg SECRET" }), /memory/);
  assert.doesNotMatch(renderFailureDetail({ signal: "SIGKILL", message: "ffmpeg SECRET" }), /SECRET/);
  assert.match(renderFailureDetail({ code: "ABORT_ERR" }), /deadline/);
  assert.match(renderFailureDetail({ code: "ETIMEDOUT", killed: true }), /time limit/);
  assert.match(renderFailureDetail({ code: 1 }), /code 1/);
  assert.equal(renderFailureDetail({ stderr: " invalid crop " }), "invalid crop");
});

test("manual cuts use sequential trimmed branches and keep tracking output origins", () => {
  const source = sourceSettings({ tracking: { enabled: true, mode: "autoFace", faceId: "face",
    startSeconds: 0, endSeconds: 3, zoom: 1.2, smoothness: .7, deadZonePct: 4,
    track: [{ t: 0, x: .2, y: .2, w: .2, h: .2, confidence: .9, faceId: "face" },
      { t: 3, x: .5, y: .2, w: .2, h: .2, confidence: .9, faceId: "face" }] } });
  const edit = { segments: [{ srcStart: 0, srcEnd: 1, transform: { zoom: 2 } },
    { srcStart: 1, srcEnd: 3 }] };
  const graph = directorLayoutFilter({ layout: "blurfit" }, 108, 192, 320, 180, source, edit);
  assert.match(graph, /concat=n=2/);
  assert.match(graph, /trim=start_frame=30:end_frame=90/);
  assert.match(graph, /\(t\+1\)/);
  assert.doesNotMatch(graph, /defaultbase|placed\d|replaced\d/);
});

test("fractional cuts, sub-frame sections and occurrence gaps retain exact frame counts in fill and blurfit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-framing-"));
  try {
    const edits = [
      { segments: [{ srcStart: 0, srcEnd: .531, transform: { zoom: 1.2, xPct: 20 } },
        { srcStart: .531, srcEnd: .532, transform: { zoom: 1.5 } },
        { srcStart: .532, srcEnd: 1.621 }, { srcStart: 1.621, srcEnd: 3.3, transform: { zoom: 2, xPct: 80 } }] },
      { version: 2, segments: [{ id: "first", srcStart: 0, srcEnd: .531, outputStart: 0, transform: { zoom: 1.2 } },
        { id: "repeat", srcStart: 0, srcEnd: 1.4, outputStart: 1.9, transform: { zoom: 1.5 } }] },
    ];
    for (const layout of ["fill", "blurfit"]) for (const [index, edit] of edits.entries()) {
      const graph = directorLayoutFilter({ layout }, 108, 192, 320, 180, sourceSettings(), edit);
      const script = path.join(dir, "filters.txt"), output = path.join(dir, `${layout}-${index}.mp4`);
      fs.writeFileSync(script, graph);
      execFileSync(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
        "-threads", "1", "-filter_complex_threads", "1", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3.3",
        "-filter_complex_script", script, "-map", "[base]", "-an", "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", output], { timeout: 30000 });
      const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height,nb_frames", "-of", "json", output], { encoding: "utf8" }));
      assert.deepEqual(info.streams.map(s => [s.width, s.height, Number(s.nb_frames)]), [[108, 192, 99]]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
