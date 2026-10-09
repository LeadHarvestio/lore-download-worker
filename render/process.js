import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { renderHeadlinePng, FONT_DIR } from "./headline.js";
import { buildAss } from "./captions.js";
import { resolveStyle } from "./styles.js";
import { muteVolumeFilter } from "./censorship.js";
import { headlinePosition, previewWords } from "./placement.js";
import { layoutFilter, sourceSettings } from "./framing.js";
import { createRenderCache, fileFingerprint, contentFingerprint } from "./cache.js";
import { prepareCreativeInputs } from "./creative.js";

const run = promisify(execFile);
const cache = createRenderCache();
export const OUT_W = 1080, OUT_H = 1920, FPS = 30;
export const PREVIEW_W = 1080, PREVIEW_H = 1920;

export async function probe(file) {
  const { stdout } = await run(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  return { width: v?.width, height: v?.height, duration: parseFloat(j.format.duration) || 0, hasAudio: !!a };
}

// Convert any audio (5.1, 5.1(side), quad, mono, unknown layout...) to plain stereo 44.1 kHz WAV
// so the filter graph never has to negotiate an unusual channel layout.
async function normalizeAudio(src, dest, voice = false, signal) {
  await run(process.env.FFMPEG_BIN || "ffmpeg",
    ["-y", "-hide_banner", "-loglevel", "error", "-threads", "2", "-i", src, "-vn", "-map", "0:a:0",
      ...(voice ? ["-af", "aformat=sample_rates=44100:channel_layouts=stereo,loudnorm=I=-16:TP=-1.5:LRA=11,aformat=sample_rates=44100:channel_layouts=stereo"] : []),
      "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", dest],
    { timeout: 5 * 60 * 1000, signal, maxBuffer: 10 * 1024 * 1024 });
  return dest;
}

function esc(p) { return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'"); }

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
  const begin = performance.now();
  // All preparation/encoding share one budget; sequential stages cannot each
  // spend ten minutes while the app believes the whole render has timed out.
  const deadline = AbortSignal.timeout(10 * 60 * 1000);
  const leases = [];
  const hits = { background: false, voice: false, music: false };
  const info = await probe(p.inputPath);
  const style = p.style;
  const source = sourceSettings(style.source);
  const preview = typeof p.previewAt === "number";
  const width = preview ? PREVIEW_W : OUT_W;
  const height = preview ? PREVIEW_H : OUT_H;
  fs.mkdirSync(p.workDir, { recursive: true });
  try {

  const hl = renderHeadlinePng({ text: p.headline.text, highlight: p.headline.highlight, width, height, style: style.headline });
  const hlPath = path.join(p.workDir, "headline.png");
  fs.writeFileSync(hlPath, hl.buffer);

  const assWords = preview ? previewWords(p.words || [], p.previewAt) : p.words || [];
  const assText = buildAss({ words: assWords, width, height, style: style.caption });
  const assPath = path.join(p.workDir, "captions.ass");
  fs.writeFileSync(assPath, assText);

  const dur = preview ? 1 : info.duration;
  const yTop = headlinePosition({ sourceWidth: info.width, sourceHeight: info.height,
    width, height, headline: hl, style });
  const secs = style.headline.seconds;
  const enable = secs ? `:enable='between(t,0,${secs - (preview ? p.previewAt : 0)})'` : "";

  // Clean stereo copies of the source audio and the music (see normalizeAudio)
  let voiceWav = null, musicWav = null;
  if (!preview) {
    if (info.hasAudio) {
      try {
        const voice = await cache.acquire("voice-loudnorm-v1", fileFingerprint(p.inputPath), "wav", dest => normalizeAudio(p.inputPath, dest, true, deadline));
        leases.push(voice); voiceWav = voice.file; hits.voice = voice.hit;
      }
      catch (e) { throw new Error("Source audio could not be decoded: " + String(e.stderr || e.message).slice(0, 200)); }
    }
    if (p.musicPath) {
      try {
        const music = await cache.acquire("music-stereo-v1", await contentFingerprint(p.musicPath), "wav", dest => normalizeAudio(p.musicPath, dest, false, deadline));
        leases.push(music); musicWav = music.file; hits.music = music.hit;
      }
      catch (e) { throw new Error("Music file could not be decoded: " + String(e.stderr || e.message).slice(0, 200)); }
    }
  }
  let backgroundPath = p.inputPath;
  if (!preview) {
    const { muteAudio, ...geometry } = source;
    const background = await cache.acquire("background-1080p-v1", { input: fileFingerprint(p.inputPath), width, height, fps: FPS, layout: style.layout, source: geometry }, "mp4", async dest => {
      await run(process.env.FFMPEG_BIN || "ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error", "-threads", "2", "-filter_complex_threads", "1", "-i", p.inputPath,
        "-filter_complex", layoutFilter(style.layout, width, height, info.width, info.height, source),
        "-map", "[base]", "-an", "-t", dur.toFixed(2), "-c:v", "libx264", "-threads", "2", "-preset", "veryfast",
        "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", dest,
      ], { timeout: 10 * 60 * 1000, signal: deadline, maxBuffer: 20 * 1024 * 1024 });
    });
    leases.push(background); backgroundPath = background.file; hits.background = background.hit;
  }
  const prepared = performance.now();

  // Bound filter threading: concurrent PNG previews otherwise exhaust worker resources.
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-threads", "2", "-filter_complex_threads", "1"];
  if (preview) args.push("-ss", String(p.previewAt));
  args.push("-i", backgroundPath, "-loop", "1", "-t", String(dur), "-i", hlPath);
  let nextIdx = 2, musicIdx = null, voiceIdx = null;
  if (musicWav) { args.push("-stream_loop", "-1", "-i", musicWav); musicIdx = nextIdx++; }
  if (voiceWav) { args.push("-i", voiceWav); voiceIdx = nextIdx++; }

  const creative = await prepareCreativeInputs({ style, args, nextIndex: nextIdx, width, height, duration: dur,
    previewAt: preview ? p.previewAt : undefined, originalPath: p.inputPath, originalIndex: preview ? 0 : undefined });
  const f = [
    preview ? layoutFilter(style.layout, width, height, info.width, info.height, source) : "[0:v]setsar=1[base]",
    ...creative.filters,
    `[1:v]format=rgba[hl]`,
    `[${creative.label}][hl]overlay=x=(W-w)/2:y=${yTop}${enable}[withhl]`,
    `[withhl]ass='${esc(assPath)}':fontsdir='${esc(FONT_DIR)}',format=yuv420p[outv]`,
  ];

  const STEREO = "aformat=sample_rates=44100:channel_layouts=stereo";
  // Muting is applied only to the normalized voice, before mixing music.
  const mute = muteVolumeFilter(p.muteRanges || []);
  const voiceFilters = `${STEREO}${mute ? "," + mute : ""}${source.muteAudio ? ",volume=0" : ""}`;
  let mapAudio = [];
  if (!preview) {
    const gain = typeof p.musicDb === "number" ? p.musicDb : -15;
    const fadeOutAt = Math.max(0, dur - 1).toFixed(2);
    const music = `[${musicIdx}:a]atrim=0:${dur.toFixed(2)},asetpts=PTS-STARTPTS,afade=t=in:d=0.5,afade=t=out:st=${fadeOutAt}:d=1`;
    if (musicWav && voiceWav) {
      f.push(`[${voiceIdx}:a]${voiceFilters}[voice]`);
      f.push(`${music},volume=${gain}dB,${STEREO}[mus]`);
      f.push(`[voice][mus]amix=inputs=2:duration=first:dropout_transition=0,volume=2,alimiter=limit=0.95,${STEREO}[outa]`);
      mapAudio = ["-map", "[outa]"];
    } else if (musicWav) {
      f.push(`${music},volume=${gain + 9}dB,${STEREO}[outa]`);
      mapAudio = ["-map", "[outa]"];
    } else if (voiceWav) {
      f.push(`[${voiceIdx}:a]${voiceFilters}[outa]`);
      mapAudio = ["-map", "[outa]"];
    }
  }

  if (!preview && creative.audioLabels.length) {
    f.push(...creative.audioFilters);
    const inputs = [...(mapAudio.length ? ["outa"] : []), ...creative.audioLabels];
    f.push(`${inputs.map(label => `[${label}]`).join("")}amix=inputs=${inputs.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95:level=0,${STEREO}[withcontextaudio]`);
    mapAudio = ["-map", "[withcontextaudio]"];
  }
  args.push("-filter_complex", f.join(";"), "-map", "[outv]", ...mapAudio);
  if (preview) {
    args.push("-frames:v", "1", "-threads", "1", p.outputPath);
  } else {
    args.push("-t", dur.toFixed(2), "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ac", "2", "-ar", "44100", "-b:a", "192k", "-movflags", "+faststart", p.outputPath);
  }

  await run(process.env.FFMPEG_BIN || "ffmpeg", args, { timeout: 10 * 60 * 1000, signal: deadline, maxBuffer: 20 * 1024 * 1024 });
  const renderStats = { preparationMs: Math.round(prepared - begin), encodeMs: Math.round(performance.now() - prepared), totalMs: Math.round(performance.now() - begin), cacheHits: hits };
  if (!preview) console.log("[RenderTiming] " + JSON.stringify(renderStats));
  return { duration: dur, width, height, headlineLines: hl.lines, headlineFontSize: hl.fontSize, renderStats };
  } finally {
    for (const lease of leases.reverse()) lease.release();
  }
}

export { resolveStyle };
