import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { renderHeadlinePng, FONT_DIR } from "./headline.js";
import { buildAss } from "./captions.js";
import { resolveStyle } from "./styles.js";

const run = promisify(execFile);
export const OUT_W = 1080, OUT_H = 1920, FPS = 30;

export async function probe(file) {
  const { stdout } = await run(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  return { width: v?.width, height: v?.height, duration: parseFloat(j.format.duration) || 0, hasAudio: !!a };
}

function esc(p) { return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'"); }

function layoutFilter(layout) {
  if (layout === "fill") {
    return `[0:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1,fps=${FPS}[base]`;
  }
  // blurfit: blurred, darkened copy fills the frame; sharp source centred on top
  return [
    `[0:v]split=2[va][vb]`,
    `[va]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},boxblur=40:6,eq=brightness=-0.12:saturation=1.1[bg]`,
    `[vb]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,setsar=1[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${FPS}[base]`,
  ].join(";");
}

/**
 * @param {object} p
 * @param p.inputPath      downloaded source clip
 * @param p.outputPath     where to write the finished mp4
 * @param p.workDir        scratch dir
 * @param p.headline       { text, highlight: string[] }
 * @param p.words          Whisper words [{word,start,end}]
 * @param p.style          resolved style (see styles.js)
 * @param p.musicPath      optional local music file
 * @param p.musicDb        music gain in dB (default -15)
 * @param p.previewAt      if set, render a single PNG frame at this time instead of a video
 */
export async function processClip(p) {
  const info = await probe(p.inputPath);
  const style = p.style;
  fs.mkdirSync(p.workDir, { recursive: true });

  const hl = renderHeadlinePng({ text: p.headline.text, highlight: p.headline.highlight, width: OUT_W, height: OUT_H, style: style.headline });
  const hlPath = path.join(p.workDir, "headline.png");
  fs.writeFileSync(hlPath, hl.buffer);

  const assText = buildAss({ words: p.words || [], width: OUT_W, height: OUT_H, style: style.caption });
  const assPath = path.join(p.workDir, "captions.ass");
  fs.writeFileSync(assPath, assText);

  const preview = typeof p.previewAt === "number";
  const dur = preview ? 1 : info.duration;
  const yTop = `${(style.headline.yPct / 100).toFixed(4)}*H-h/2`;
  const secs = style.headline.seconds;
  const enable = secs ? `:enable='between(t,0,${secs})'` : "";

  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  if (preview) args.push("-ss", String(p.previewAt));
  args.push("-i", p.inputPath, "-loop", "1", "-t", String(dur), "-i", hlPath);
  const useMusic = !preview && p.musicPath;
  if (useMusic) args.push("-stream_loop", "-1", "-i", p.musicPath);

  const f = [
    layoutFilter(style.layout),
    `[1:v]format=rgba[hl]`,
    `[base][hl]overlay=x=(W-w)/2:y=${yTop}${enable}[withhl]`,
    `[withhl]ass='${esc(assPath)}':fontsdir='${esc(FONT_DIR)}',format=yuv420p[outv]`,
  ];

  let mapAudio = [];
  if (!preview) {
    const gain = typeof p.musicDb === "number" ? p.musicDb : -15;
    if (useMusic && info.hasAudio) {
      f.push(`[0:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100[voice]`);
      f.push(`[2:a]atrim=0:${dur.toFixed(2)},asetpts=PTS-STARTPTS,afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, dur - 1).toFixed(2)}:d=1,volume=${gain}dB,aresample=44100[mus]`);
      f.push(`[voice][mus]amix=inputs=2:duration=first:dropout_transition=0,volume=2,alimiter=limit=0.95[outa]`);
      mapAudio = ["-map", "[outa]"];
    } else if (useMusic) {
      f.push(`[2:a]atrim=0:${dur.toFixed(2)},asetpts=PTS-STARTPTS,afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, dur - 1).toFixed(2)}:d=1,volume=${gain + 9}dB,aresample=44100[outa]`);
      mapAudio = ["-map", "[outa]"];
    } else if (info.hasAudio) {
      f.push(`[0:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100[outa]`);
      mapAudio = ["-map", "[outa]"];
    }
  }

  args.push("-filter_complex", f.join(";"), "-map", "[outv]", ...mapAudio);
  if (preview) {
    args.push("-frames:v", "1", p.outputPath);
  } else {
    args.push("-t", dur.toFixed(2), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", p.outputPath);
  }

  await run(process.env.FFMPEG_BIN || "ffmpeg", args, { timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
  return { duration: dur, headlineLines: hl.lines, headlineFontSize: hl.fontSize };
}

export { resolveStyle };
