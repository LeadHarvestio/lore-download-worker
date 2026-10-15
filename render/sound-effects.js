import { downloadAsset } from "./creative.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { speechDuckingFilter, voiceDuckingSchema } from "./voice-ducking.js";
const run = promisify(execFile);
async function audioDuration(file) {
  const { stdout } = await run(process.env.FFPROBE_BIN || "ffprobe",
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration:format=duration", "-of", "json", file],
    { timeout: 15000, maxBuffer: 1024 * 1024 });
  const info = JSON.parse(stdout);
  const duration = Number(info.streams?.[0]?.duration ?? info.format?.duration);
  if (!info.streams?.length || !Number.isFinite(duration) || duration <= 0) throw new Error("Sound effect has no usable saved audio.");
  return duration;
}

export async function prepareSoundEffects({ effects = [], args, nextIndex, duration, preview, words }, resolver = downloadAsset, inspect = audioDuration) {
  if (!Array.isArray(effects) || effects.length > 30) throw new Error("Invalid sound effect count.");
  const labels = [], filters = [];
  const seen = new Set();
  let index = nextIndex;
  for (const effect of effects) {
    if (!/^[a-f0-9-]{36}$/i.test(effect.id) || seen.has(effect.id) ||
        !/^[a-f0-9-]{36}$/i.test(effect.assetId) ||
        !Number.isFinite(effect.startSeconds) || effect.startSeconds < 0 || effect.startSeconds > 1800 ||
        !Number.isFinite(effect.trimStartSeconds) || effect.trimStartSeconds < 0 ||
        !Number.isFinite(effect.durationSeconds) || effect.durationSeconds <= 0 || effect.durationSeconds > 1800 ||
        !Number.isFinite(effect.assetDurationSeconds) || effect.assetDurationSeconds <= 0 ||
        effect.trimStartSeconds + effect.durationSeconds > effect.assetDurationSeconds + .05 ||
        !Number.isFinite(effect.volumeDb) || effect.volumeDb < -30 || effect.volumeDb > 0 ||
        typeof effect.muted !== "boolean") throw new Error("Invalid sound effect.");
    seen.add(effect.id);
    if (effect.voiceDucking !== undefined) {
      voiceDuckingSchema.parse(effect.voiceDucking);
      if (!Array.isArray(words)) throw new Error("Speech ducking requires saved output-time words; no automatic transcription.");
    }
    // A static image has no audio; muted and out-of-range effects need no fetch.
    if (preview || effect.muted || effect.startSeconds >= duration) continue;
    const file = await resolver({ ...effect, kind: "audio" });
    const savedDuration = await inspect(file);
    if (effect.trimStartSeconds + effect.durationSeconds > savedDuration + .05)
      throw new Error("Sound effect trim exceeds the actual saved audio.");
    args.push("-i", file);
    const input = index++, label = `sfx${labels.length}`;
    const length = Math.min(effect.durationSeconds, duration - effect.startSeconds);
    // Delay before reframing: FFmpeg 6 can drop leading silence if adelay sees
    // small repacketized frames. Duck the padded, output-time stream instead.
    const ducking = speechDuckingFilter(effect.voiceDucking, words, 0, duration);
    filters.push(`[${input}:a]atrim=start=${effect.trimStartSeconds}:duration=${length},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,volume=${effect.volumeDb}dB,adelay=${Math.round(effect.startSeconds * 1000)}:all=1,aresample=async=1:first_pts=0,apad,atrim=duration=${duration}${ducking}[${label}]`);
    labels.push(label);
  }
  return { labels, filters, nextIndex: index };
}
