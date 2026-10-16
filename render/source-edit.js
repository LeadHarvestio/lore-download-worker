// shared/source-media.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

// shared/source-edit.ts
import { z as z2 } from "zod";

// shared/affine-transform.ts
import { z } from "zod";
var affineTransformSchema = z.object({
  version: z.literal(1),
  rotationDeg: z.number().finite().min(-180).max(180).optional(),
  scaleX: z.number().finite().min(0.1).max(3).optional(),
  scaleY: z.number().finite().min(0.1).max(3).optional()
}).strict();

// shared/source-edit.ts
var segmentDuration = (segment) => (segment.srcEnd - segment.srcStart) / (segment.speed ?? 1);
var sourceEditSchema = z2.object({
  version: z2.literal(2).optional(),
  segments: z2.array(z2.object({
    instanceId: z2.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/).optional(),
    outputStart: z2.number().finite().min(0).max(1800).optional(),
    punchScale: z2.number().finite().min(1).max(1.15).optional(),
    srcStart: z2.number().finite().min(0).max(1800),
    srcEnd: z2.number().finite().positive().max(1800),
    speed: z2.number().finite().min(0.25).max(4).optional(),
    transform: z2.object({
      affine: affineTransformSchema.optional(),
      xPct: z2.number().finite().min(0).max(100).optional(),
      yPct: z2.number().finite().min(0).max(100).optional(),
      zoom: z2.number().finite().min(1).max(3).optional(),
      cropLeftPct: z2.number().finite().min(0).max(40).optional(),
      cropRightPct: z2.number().finite().min(0).max(40).optional(),
      cropTopPct: z2.number().finite().min(0).max(40).optional(),
      cropBottomPct: z2.number().finite().min(0).max(40).optional()
    }).strict().optional()
  }).strict()).min(1).max(40)
}).strict().superRefine((edit, ctx) => {
  let previousEnd = 0;
  const ids = /* @__PURE__ */ new Set();
  edit.segments.forEach((segment, index) => {
    if (segment.srcEnd <= segment.srcStart || (edit.version === 2 ? segment.outputStart === void 0 || !segment.instanceId || ids.has(segment.instanceId) || segment.outputStart < previousEnd - 1e-8 : segment.srcStart < previousEnd || segment.instanceId !== void 0 || segment.outputStart !== void 0)) {
      ctx.addIssue({ code: "custom", path: ["segments", index], message: edit.version === 2 ? "Source instances require unique IDs and ordered, non-overlapping output positions." : "Segments must be ordered, non-overlapping and have positive duration." });
    }
    if (segment.instanceId) ids.add(segment.instanceId);
    previousEnd = edit.version === 2 ? (segment.outputStart ?? 0) + segmentDuration(segment) : segment.srcEnd;
  });
  if (outputDuration(edit) > 1800) ctx.addIssue({ code: "custom", message: "Edited output exceeds 30 minutes." });
});
function outputDuration(edit) {
  return sourceInstances(edit).at(-1)?.end ?? 0;
}
function validateSourceEdit(value, sourceDuration = 1800) {
  const edit = sourceEditSchema.parse(value);
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0 || edit.segments.some((segment) => segment.srcEnd > sourceDuration + 1e-3)) {
    throw new Error("A source segment extends beyond the original video.");
  }
  return edit;
}
function sourceInstances(edit) {
  let cursor = 0;
  return edit.segments.map((segment, index) => {
    const start = edit.version === 2 ? segment.outputStart : cursor;
    const end = start + segmentDuration(segment);
    cursor = end;
    return { segment, index, start, end };
  });
}

// shared/source-media.ts
var run = promisify(execFile);
function validateSourceEdit2(value, duration = 1800) {
  try {
    const edit = validateSourceEdit(value, duration);
    if (outputDuration(edit) < 1) throw new Error("Keep at least one second of footage.");
    return { ...edit, segments: edit.segments.map((segment) => ({ ...segment, speed: segment.speed ?? 1 })) };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error("Invalid source edit."), { status: 400 });
  }
}
var sourceEditDuration = outputDuration;
function tempoChain(speed) {
  const factors = [];
  while (speed < 0.5) {
    factors.push(0.5);
    speed /= 0.5;
  }
  while (speed > 2) {
    factors.push(2);
    speed /= 2;
  }
  factors.push(speed);
  return factors.map((factor) => `atempo=${factor}`).join(",");
}
function sourceEditParts(edit) {
  const parts = [];
  let cursor = 0;
  const add = (start, end, segment) => parts.push({
    start,
    end,
    segment,
    frames: Math.round(end * 30) - Math.round(start * 30),
    samples: Math.round(end * 44100) - Math.round(start * 44100)
  });
  for (const item of sourceInstances(edit)) {
    if (item.start > cursor) add(cursor, item.start);
    add(item.start, item.end, item.segment);
    cursor = item.end;
  }
  return parts;
}
function sourceEditClock(edit) {
  return sourceEditParts(edit).map(({ frames, samples }) => ({ frames, samples }));
}
function sourceEditFilter(edit, hasAudio) {
  if (edit.version === 2) throw new Error("Source instances must use the bounded encoder.");
  const filters = [], video = [], audio = [], count = edit.segments.length;
  const clock = sourceEditClock(edit);
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
  filters.push(`${video.join("")}concat=n=${video.length}:v=1:a=0,setpts=N/(30*TB)[v]`);
  if (hasAudio) filters.push(`${audio.join("")}concat=n=${audio.length}:v=0:a=1,asetpts=N/SR/TB[a]`);
  return filters.join(";");
}
async function encodeSourceEdit(input, output, value, hasAudio, signal, options = {}) {
  const binary = process.env.FFMPEG_BIN || "ffmpeg";
  const base = ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "2", "-filter_complex_threads", "1"];
  const exec = (args) => run(binary, [...base, ...args], { signal, maxBuffer: 1024 * 1024 });
  const edit = validateSourceEdit2(value);
  if (edit.version !== 2) {
    await exec([
      "-i",
      input,
      "-filter_complex",
      sourceEditFilter(edit, hasAudio),
      "-map",
      "[v]",
      ...hasAudio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : ["-an"],
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "2",
      "-movflags",
      "+faststart",
      output
    ]);
    return;
  }
  const probe = await run(process.env.FFPROBE_BIN || "ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height:format=duration",
    "-of",
    "json",
    input
  ], { signal, maxBuffer: 65536 });
  const info = JSON.parse(probe.stdout);
  validateSourceEdit2(edit, Number(info.format.duration) + 0.05);
  const stream = info.streams[0];
  if (!stream?.width || !stream?.height) throw new Error("Original video has no readable frames.");
  const scale = Math.min(1, (options.maxDimension ?? Infinity) / Math.max(stream.width, stream.height));
  const width = Math.max(2, Math.floor(stream.width * scale / 2) * 2), height = Math.max(2, Math.floor(stream.height * scale / 2) * 2);
  const dir = await mkdtemp(join(dirname(output), "source-instances-"));
  try {
    const videos = [], audios = [];
    for (const [index, part] of sourceEditParts(edit).entries()) {
      if (signal?.aborted) signal.throwIfAborted();
      const segment = part.segment, speed = segment?.speed ?? 1;
      const videoFile = join(dir, `${index}.mp4`), audioFile = join(dir, `${index}.wav`);
      const args = segment ? ["-ss", String(segment.srcStart), "-i", input] : [
        "-f",
        "lavfi",
        "-i",
        `color=c=black:s=${width}x${height}:r=30`,
        ...hasAudio ? ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"] : []
      ];
      const video = segment ? `trim=duration=${segment.srcEnd - segment.srcStart},setpts=(PTS-STARTPTS)/${speed},fps=30:start_time=0,scale=${width}:${height},tpad=stop_mode=clone:stop=-1,trim=end_frame=${part.frames},setpts=N/(30*TB),setsar=1` : `trim=end_frame=${part.frames},setpts=N/(30*TB),setsar=1`;
      const audio = `${segment ? `atrim=duration=${segment.srcEnd - segment.srcStart},` : ""}asetpts=PTS-STARTPTS,${speed === 1 ? "" : `${tempoChain(speed)},`}aformat=sample_rates=44100:channel_layouts=stereo,apad,atrim=end_sample=${part.samples},asetpts=N/SR/TB`;
      const filters = [
        ...part.frames ? [`[0:v]${video}[v]`] : [],
        ...hasAudio && part.samples ? [`[${segment ? "0:a" : "1:a"}]${audio}[a]`] : []
      ];
      args.push("-filter_complex", filters.join(";"));
      if (part.frames) {
        args.push("-map", "[v]", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", "-threads", "2", "-video_track_timescale", "90000", videoFile);
        videos.push(videoFile);
      }
      if (hasAudio && part.samples) {
        args.push("-map", "[a]", "-vn", "-c:a", "pcm_s16le", audioFile);
        audios.push(audioFile);
      }
      if (part.frames || hasAudio && part.samples) await exec(args);
    }
    const list = (paths) => paths.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n") + "\n";
    await writeFile(join(dir, "video.txt"), list(videos));
    if (hasAudio) await writeFile(join(dir, "audio.txt"), list(audios));
    await exec([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      join(dir, "video.txt"),
      ...hasAudio ? ["-f", "concat", "-safe", "0", "-i", join(dir, "audio.txt")] : [],
      "-map",
      "0:v",
      "-c:v",
      "copy",
      ...hasAudio ? ["-map", "1:a", "-c:a", "aac", "-b:a", "192k"] : ["-an"],
      "-movflags",
      "+faststart",
      output
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export {
  encodeSourceEdit,
  sourceEditClock,
  sourceEditDuration,
  sourceEditFilter,
  sourceEditParts,
  tempoChain,
  validateSourceEdit2 as validateSourceEdit
};
