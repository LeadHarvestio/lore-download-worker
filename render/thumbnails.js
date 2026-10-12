import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export function validateThumbnail(value) {
  if (!value || typeof value !== "object" || Object.keys(value).some(key => !["filename", "atSeconds", "width", "height", "format"].includes(key))) fail(400, "Unknown thumbnail field.");
  if (!/^[a-zA-Z0-9_-]+\.mp4$/.test(value.filename || "")) fail(400, "Invalid finished-video filename.");
  if (!Number.isFinite(value.atSeconds) || value.atSeconds < 0 || value.atSeconds > 1800) fail(400, "Invalid frame time.");
  if (![[1080, 1920], [1080, 1080], [1280, 720]].some(([w, h]) => w === value.width && h === value.height)) fail(400, "Unsupported crop.");
  if (!["jpg", "png"].includes(value.format)) fail(400, "Use JPG or PNG.");
  return value;
}
export function createThumbnailService(directory) {
  const holds = new Map(), inflight = new Map();
  const frames = new Map();
  let cachedBytes = 0;
  let active = 0;
  const waiters = [];
  async function slot() {
    if (active >= 2) await new Promise(resolve => waiters.push(resolve));
    else active++;
  }
  function release() { const next = waiters.shift(); if (next) next(); else active--; }
  return {
    hold(filename, pending) {
      if (!/^[a-zA-Z0-9_-]+\.mp4$/.test(filename || "") || typeof pending !== "boolean") fail(400, "Invalid retention request.");
      if (!fs.existsSync(path.join(directory, filename))) fail(404, "Finished video is unavailable.");
      if (pending) {
        const previous = holds.get(filename);
        holds.set(filename, previous || Date.now() + Math.max(4, Math.min(72, Number(process.env.THUMBNAIL_KEEP_HOURS || 24))) * 3600000);
      } else holds.delete(filename);
    },
    held(filename) { const until = holds.get(filename); if (until && until > Date.now()) return true; holds.delete(filename); return false; },
    async extract(input) {
      const value = validateThumbnail(input), source = path.join(directory, value.filename);
      if (!fs.existsSync(source)) fail(404, "Finished video is unavailable.");
      const stat = fs.statSync(source), key = crypto.createHash("sha256").update(JSON.stringify({ ...value, size: stat.size, mtime: stat.mtimeMs })).digest("hex");
      if (frames.has(key)) {
        const bytes = frames.get(key); frames.delete(key); frames.set(key, bytes); return bytes;
      }
      if (inflight.has(key)) return inflight.get(key);
      if (waiters.length >= 20) fail(429, "Thumbnail queue is full.");
      const task = (async () => {
        await slot();
        const output = path.join(directory, `thumbnail_${key}.${value.format}`);
        try {
          const probe = JSON.parse((await run(process.env.FFPROBE_BIN || "ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=avg_frame_rate,codec_type", "-of", "json", source], { timeout: 10000 })).stdout);
          const duration = Number(probe.format.duration);
          if (!Number.isFinite(duration) || value.atSeconds > duration) fail(400, "Frame time exceeds video duration.");
          const fpsValue = probe.streams.find(s => s.codec_type === "video")?.avg_frame_rate || "30/1";
          const [num, den] = fpsValue.split("/").map(Number), fps = num / den || 30;
          const at = Math.min(Math.round(value.atSeconds * fps) / fps, Math.max(0, duration - 1 / fps));
          if (!fs.existsSync(output)) await run(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-threads", "1",
            "-ss", String(at), "-i", source, "-an", "-vf", `scale=${value.width}:${value.height}:force_original_aspect_ratio=increase,crop=${value.width}:${value.height}`,
            "-frames:v", "1", ...(value.format === "jpg" ? ["-q:v", "2"] : []), output], { timeout: 30000 });
          const bytes = fs.readFileSync(output);
          if (value.format === "jpg" && bytes.length > 2 * 1024 * 1024) fail(413, "JPG exceeds 2 MB.");
          if (bytes.length <= 6 * 1024 * 1024) {
            frames.set(key, bytes); cachedBytes += bytes.length;
            while (frames.size > 16 || cachedBytes > 12 * 1024 * 1024) {
              const oldest = frames.keys().next().value;
              cachedBytes -= frames.get(oldest).length; frames.delete(oldest);
            }
          }
          return bytes;
        } finally { release(); fs.rmSync(output, { force: true }); }
      })();
      inflight.set(key, task);
      try { return await task; } finally { inflight.delete(key); }
    },
  };
}
