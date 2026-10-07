import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_MUSIC_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TRANSCRIBE_TIMEOUT_MS = 14 * 60 * 1000;
const FFMPEG_TIMEOUT_MS = 14 * 60 * 1000;

function safeText(value, limit = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function normalizeToken(value) {
  return String(value ?? "").toLocaleUpperCase("en-US").match(/[\p{L}\p{N}]+/gu)?.join("") || "";
}

function escapeAss(value) {
  return safeText(value, 300)
    .replace(/\\/g, "\\\\")
    .replace(/[{}]/g, "");
}

function assTimestamp(seconds) {
  const centiseconds = Math.max(0, Math.floor(seconds * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const remainder = centiseconds % 6000;
  const wholeSeconds = Math.floor(remainder / 100);
  const cs = remainder % 100;
  return `${String(hours).padStart(1, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function srtTimestamp(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const remainder = milliseconds % 60000;
  const wholeSeconds = Math.floor(remainder / 1000);
  const ms = remainder % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function normalizeWords(input, durationSeconds) {
  if (!Array.isArray(input)) throw new Error("Whisper returned an invalid word list.");
  const output = [];
  let previousEnd = 0;
  for (const item of input) {
    const text = safeText(item?.text, 120);
    const rawStart = Number(item?.start);
    const rawEnd = Number(item?.end);
    if (!text || !Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;
    const start = Math.max(previousEnd, 0, Math.min(durationSeconds, rawStart));
    const end = Math.min(durationSeconds, Math.max(start + 0.04, rawEnd));
    if (end <= start) continue;
    output.push({ start, end, text });
    previousEnd = end;
  }
  return output;
}

function buildSrt(words) {
  return words.map((word, index) => [
    String(index + 1),
    `${srtTimestamp(word.start)} --> ${srtTimestamp(word.end)}`,
    word.text.replace(/[\r\n]+/g, " "),
    "",
  ].join("\n")).join("\n");
}

function wrapHeadline(headline, maxLineLength = 22) {
  const tokens = headline.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const token of tokens) {
    if (line && `${line} ${token}`.length > maxLineLength) {
      lines.push(line);
      line = token;
    } else {
      line = line ? `${line} ${token}` : token;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : ["STREAMER CLIP"];
}

function buildHeadlineAss(lines, highlightWords) {
  const highlights = new Set(
    highlightWords.flatMap((word) => String(word).match(/[\p{L}\p{N}]+/gu) || [])
      .map(normalizeToken)
      .filter(Boolean),
  );
  return lines.map((line) => line.split(/(\s+)/).map((part) => {
    if (/^\s+$/.test(part)) return part;
    const isHighlighted = (part.match(/[\p{L}\p{N}]+/gu) || [])
      .some((word) => highlights.has(normalizeToken(word)));
    const text = escapeAss(part);
    return isHighlighted ? `{\\c&H0000FF&}${text}{\\c&HFFFFFF&}` : text;
  }).join("")).join("\\N");
}

function buildAss(headline, highlightWords, words, durationSeconds) {
  const title = safeText(headline, 80).toLocaleUpperCase("en-US") || "STREAMER CLIP";
  const headlineLines = wrapHeadline(title);
  const headlineText = buildHeadlineAss(headlineLines, highlightWords);
  const events = [
    `Dialogue: 0,0:00:00.00,${assTimestamp(durationSeconds)},Headline,,0,0,0,,${headlineText}`,
  ];
  for (const word of words) {
    events.push(
      `Dialogue: 1,${assTimestamp(word.start)},${assTimestamp(word.end)},Caption,,0,0,0,,${escapeAss(word.text)}`,
    );
  }
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Headline,DejaVu Sans,72,&H00FFFFFF,&H0000FFFF,&H00101010,&H00000000,-1,0,0,0,100,100,0,0,1,3,2,8,42,42,54,1",
    "Style: Caption,DejaVu Sans,76,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,5,2,2,80,80,330,1",
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ...events,
    "",
  ].join("\n");
}

function isPrivateAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (family === 6) {
    const value = address.toLowerCase().split("%")[0];
    if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
    return value === "::" || value === "::1" ||
      value.startsWith("fc") || value.startsWith("fd") ||
      /^fe[89ab]/.test(value) || value.startsWith("ff");
  }
  return true;
}

async function assertPublicHttpUrl(url) {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Music URL must be an HTTP or HTTPS address without embedded credentials.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("Music URL must use a public host.");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Music URL must resolve to a public host.");
  }
}

async function fetchMusicFile(musicUrl, destination) {
  let target;
  try {
    target = new URL(musicUrl);
  } catch {
    throw new Error("Music URL is invalid.");
  }

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    await assertPublicHttpUrl(target);
    const response = await fetch(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(45_000),
      headers: { "User-Agent": "27CLUB-Clip-Worker/1.0" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirectCount === MAX_REDIRECTS) throw new Error("Music download exceeded the redirect limit.");
      target = new URL(location, target);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Music download failed with HTTP ${response.status}.`);
    }
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_MUSIC_BYTES) {
      await response.body.cancel();
      throw new Error("Music file exceeds the 100 MB worker limit.");
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_MUSIC_BYTES) {
          await reader.cancel();
          throw new Error("Music file exceeds the 100 MB worker limit.");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    if (!total) throw new Error("Music URL returned an empty file.");
    fs.writeFileSync(destination, Buffer.concat(chunks, total));
    return destination;
  }
  throw new Error("Music download failed.");
}

async function probeVideo(filePath) {
  const { stdout } = await execFileAsync(process.env.FFPROBE_BIN || "ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height",
    "-of", "json",
    filePath,
  ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const probe = JSON.parse(stdout);
  const video = (probe.streams || []).find((stream) => stream.codec_type === "video");
  const durationSeconds = Number(probe.format?.duration);
  if (!video || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("The downloaded file is not a readable video.");
  }
  if (durationSeconds > 900) throw new Error("Clips longer than 15 minutes cannot be processed.");
  return {
    width: Number(video.width),
    height: Number(video.height),
    durationSeconds,
    hasAudio: (probe.streams || []).some((stream) => stream.codec_type === "audio"),
  };
}

async function transcribeVideo(clipPath) {
  const scriptPath = path.join(MODULE_DIR, "transcribe.py");
  const { stdout } = await execFileAsync(process.env.PYTHON_BIN || "python3", [
    scriptPath,
    clipPath,
  ], {
    timeout: TRANSCRIBE_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error("Whisper returned an invalid transcription response.");
  }
  return data.words;
}

export async function processVideo({
  jobId,
  clipPath,
  outputPath,
  headline,
  highlightWords,
  musicUrl = null,
  musicFilePath = null,
  musicVolumeDb = -15,
  transcribeWords = transcribeVideo,
}) {
  if (musicVolumeDb !== -15) throw new Error("Music volume must be -15 dB.");
  if (!fs.existsSync(clipPath) || !fs.statSync(clipPath).isFile()) {
    throw new Error("The downloaded clip is missing from the worker.");
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new Error("Processing job ID is invalid.");
  if (musicUrl && musicFilePath) throw new Error("Use either a music URL or a local music file.");

  const probe = await probeVideo(clipPath);
  const normalizedHeadline = safeText(headline, 80).toLocaleUpperCase("en-US") || "STREAMER CLIP";
  const highlights = Array.isArray(highlightWords)
    ? highlightWords.map((word) => safeText(word, 60)).filter(Boolean).slice(0, 10)
    : [];
  const assPath = path.join(path.dirname(outputPath), `.${jobId}.captions.ass`);
  const srtPath = path.join(path.dirname(outputPath), `${jobId}.srt`);
  const musicPath = musicFilePath || (musicUrl ? path.join(os.tmpdir(), `${jobId}-${Date.now()}.music`) : null);
  let succeeded = false;

  try {
    const rawWords = await transcribeWords(clipPath);
    const words = normalizeWords(rawWords, probe.durationSeconds);
    fs.writeFileSync(assPath, buildAss(normalizedHeadline, highlights, words, probe.durationSeconds), "utf8");
    if (words.length) fs.writeFileSync(srtPath, buildSrt(words), "utf8");
    if (musicUrl) await fetchMusicFile(musicUrl, musicPath);

    const fontDirectory = process.env.FONT_DIR || "/usr/share/fonts/truetype/dejavu";
    const videoFilter = [
      "scale=1080:1920:force_original_aspect_ratio=increase",
      "crop=1080:1920",
      "setsar=1",
      "drawbox=x=0:y=0:w=iw:h=270:color=black@0.58:t=fill",
      `subtitles=filename=${assPath}:fontsdir=${fontDirectory}`,
    ].join(",");
    const args = ["-y", "-i", clipPath];
    if (musicPath) args.push("-stream_loop", "-1", "-i", musicPath);
    args.push("-vf", videoFilter, "-map", "0:v:0");

    if (musicPath && probe.hasAudio) {
      const duration = probe.durationSeconds.toFixed(3);
      args.push(
        "-filter_complex",
        `[0:a:0]apad=whole_dur=${duration}[source];[1:a:0]volume=${musicVolumeDb}dB,atrim=duration=${duration}[music];[source][music]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`,
        "-map", "[aout]",
      );
    } else if (musicPath) {
      const duration = probe.durationSeconds.toFixed(3);
      args.push(
        "-filter_complex",
        `[1:a:0]volume=${musicVolumeDb}dB,atrim=duration=${duration},alimiter=limit=0.95[aout]`,
        "-map", "[aout]",
      );
    } else {
      args.push("-map", "0:a:0?");
    }

    args.push(
      "-t", probe.durationSeconds.toFixed(3),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      outputPath,
    );

    try {
      await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", args, {
        timeout: FFMPEG_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      const detail = safeText(error?.stderr || error?.message || "unknown FFmpeg error", 700);
      throw new Error(`FFmpeg render failed: ${detail}`);
    }

    const outputProbe = await probeVideo(outputPath);
    if (outputProbe.width !== 1080 || outputProbe.height !== 1920) {
      throw new Error("FFmpeg output did not match the required 9:16 1080x1920 format.");
    }
    succeeded = true;
    return {
      outputPath,
      srtPath: words.length ? srtPath : null,
      durationSeconds: outputProbe.durationSeconds,
      captionWordCount: words.length,
    };
  } finally {
    for (const temporaryPath of [assPath, ...(musicUrl ? [musicPath] : [])]) {
      if (temporaryPath && fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
    if (!succeeded) {
      for (const temporaryPath of [outputPath, srtPath]) {
        if (temporaryPath && fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      }
    }
  }
}
