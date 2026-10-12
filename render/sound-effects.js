import { downloadAsset } from "./creative.js";

export async function prepareSoundEffects({ effects = [], args, nextIndex, duration, preview }, resolver = downloadAsset) {
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
    // A static image has no audio; muted and out-of-range effects need no fetch.
    if (preview || effect.muted || effect.startSeconds >= duration) continue;
    const file = await resolver({ ...effect, kind: "audio" });
    args.push("-i", file);
    const input = index++, label = `sfx${labels.length}`;
    const length = Math.min(effect.durationSeconds, duration - effect.startSeconds);
    filters.push(`[${input}:a]atrim=start=${effect.trimStartSeconds}:duration=${length},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,volume=${effect.volumeDb}dB,adelay=${Math.round(effect.startSeconds * 1000)}:all=1,apad,atrim=duration=${duration}[${label}]`);
    labels.push(label);
  }
  return { labels, filters, nextIndex: index };
}
