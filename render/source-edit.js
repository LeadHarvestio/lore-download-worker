// Worker source-cut clock, preserving the deployed per-segment motion contract.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
export function validateSourceEdit(value, duration = 1800) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "segments") ||
      !Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > 40) fail("sourceEdit needs 1–40 segments.");
  let previousEnd = 0, outputDuration = 0;
  const segments = value.segments.map(segment => {
    if (!segment || typeof segment !== "object" || Array.isArray(segment) || Object.keys(segment).some(key => !["srcStart", "srcEnd", "speed", "transform", "punchScale"].includes(key))) fail("Unknown source segment field.");
    const { srcStart, srcEnd, speed = 1 } = segment;
    if (![srcStart, srcEnd, speed].every(Number.isFinite) || srcStart < 0 || srcEnd <= srcStart || srcStart < previousEnd || srcEnd > duration + .001 || speed < .25 || speed > 4) fail("Segments must be ordered, non-overlapping, inside the source and speed 0.25–4.");
    previousEnd = srcEnd; outputDuration += (srcEnd - srcStart) / speed;
    const transform = segment.transform;
    if (transform !== undefined && (!transform || typeof transform !== "object" || Array.isArray(transform) ||
      Object.keys(transform).some(key => !["xPct", "yPct", "zoom", "cropLeftPct", "cropRightPct", "cropTopPct", "cropBottomPct"].includes(key)) ||
      Object.entries(transform).some(([key, value]) => !Number.isFinite(value) || value < (key === "zoom" ? 1 : 0) || value > (key === "zoom" ? 3 : key.startsWith("crop") ? 40 : 100)))) fail("Invalid segment placement.");
    if (segment.punchScale !== undefined && (!Number.isFinite(segment.punchScale) || segment.punchScale < 1 || segment.punchScale > 1.15)) fail("Invalid segment punch-in scale.");
    return { srcStart, srcEnd, speed, ...(transform ? { transform: { ...transform } } : {}),
      ...(segment.punchScale !== undefined ? { punchScale: segment.punchScale } : {}) };
  });
  if (outputDuration < 1 || outputDuration > 1800) fail("Edited output must be 1 second–30 minutes.");
  return { segments };
}
export function tempoChain(speed) {
  const factors = [];
  while (speed < .5) { factors.push(.5); speed /= .5; }
  while (speed > 2) { factors.push(2); speed /= 2; }
  factors.push(speed);
  return factors.map(factor => `atempo=${factor}`).join(",");
}
export function sourceEditDuration(edit) {
  return edit.segments.reduce((sum, s) => sum + (s.srcEnd - s.srcStart) / (s.speed ?? 1), 0);
}
// Quantize cumulative endpoints, NOT each shot independently. The application
// and captions retain continuous source/output time; only media needs ticks.
export function sourceEditClock(edit) {
  let cursor = 0, frame = 0, sample = 0;
  return edit.segments.map(s => {
    cursor += (s.srcEnd - s.srcStart) / (s.speed ?? 1);
    const endFrame = Math.round(cursor * 30), endSample = Math.round(cursor * 44100);
    const clock = { frames: endFrame - frame, samples: endSample - sample };
    frame = endFrame; sample = endSample;
    return clock;
  });
}
export function sourceEditFilter(edit, hasAudio) {
  const filters = [], video = [], audio = [], count = edit.segments.length;
  const clock = sourceEditClock(edit);
  // Establish a source frame grid before cutting, so even sub-frame shots can
  // select a frame. fps also handles VFR and non-zero source video start times.
  filters.push(`[0:v]fps=30:start_time=0,split=${count}${edit.segments.map((_, i) => `[vin${i}]`).join("")}`);
  if (hasAudio) filters.push(`[0:a]asplit=${count}${edit.segments.map((_, i) => `[ain${i}]`).join("")}`);
  edit.segments.forEach((segment, i) => {
    const speed = segment.speed ?? 1, { frames, samples } = clock[i];
    if (frames) {
      filters.push(`[vin${i}]trim=start_frame=${Math.floor(segment.srcStart * 30)}:end_frame=${Math.ceil(segment.srcEnd * 30)},setpts=(PTS-${segment.srcStart}/TB)/${speed},fps=30:start_time=0,tpad=stop_mode=clone:stop=-1,trim=end_frame=${frames},setpts=N/(30*TB),setsar=1[v${i}]`);
      video.push(`[v${i}]`);
    } else filters.push(`[vin${i}]nullsink`);
    if (hasAudio && samples) {
      filters.push(`[ain${i}]atrim=start=${segment.srcStart}:end=${segment.srcEnd},asetpts=PTS-STARTPTS,${speed === 1 ? "" : `${tempoChain(speed)},`}aformat=sample_rates=44100:channel_layouts=stereo,apad,atrim=end_sample=${samples},asetpts=N/SR/TB[a${i}]`);
      audio.push(`[a${i}]`);
    } else if (hasAudio) filters.push(`[ain${i}]anullsink`);
  });
  // Combined A/V concat pads each audio shot to the rounded video length.
  // Independent joins prevent that padding from shifting every later word.
  filters.push(`${video.join("")}concat=n=${video.length}:v=1:a=0,setpts=N/(30*TB)[v]`);
  if (hasAudio) filters.push(`${audio.join("")}concat=n=${audio.length}:v=0:a=1,asetpts=N/SR/TB[a]`);
  return filters.join(";");
}
export async function encodeSourceEdit(input, output, edit, hasAudio, signal) {
  await run(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-threads", "2", "-filter_complex_threads", "1",
    "-i", input, "-filter_complex", sourceEditFilter(edit, hasAudio), "-map", "[v]", ...(hasAudio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output], { signal, maxBuffer: 10 * 1024 * 1024 });
}
