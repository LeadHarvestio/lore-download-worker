// Generated from shared TypeScript by scripts/sync-worker-flash-contracts.mjs.
import { z } from "zod";
const flashFields = {
  flashVersion: z.literal(2).optional(),
  fps: z.number().finite().min(1).max(120).optional(),
  rampInFrames: z.number().int().min(2).max(3600).optional(),
  holdFrames: z.number().int().min(0).max(7200).optional(),
  rampOutFrames: z.number().int().min(2).max(3600).optional(),
  peakOpacity: z.number().finite().min(0).max(1).optional(),
  // Retains envelope phase when an existing source-clock projector cuts an item.
  flashOffsetFrames: z.number().finite().min(0).max(14400).optional()
};
const FLASH_PRESETS = {
  pulse: { rampInFrames: 15, holdFrames: 10, rampOutFrames: 15, peakOpacity: 0.65 },
  snap: { rampInFrames: 3, holdFrames: 2, rampOutFrames: 4, peakOpacity: 0.7 }
};
const FLASH_COLORS = { positive: "#00FF3C", negative: "#FF1E1E" };
const supportsFlashV2 = (caps) => (caps?.flashBlend ?? 0) >= 2;
const isFlashV2 = (e) => e.type === "flash" && e.flashVersion === 2;
const extraKeys = ["fps", "rampInFrames", "holdFrames", "rampOutFrames", "peakOpacity", "flashOffsetFrames"];
function validFlashFields(e) {
  if (e.flashVersion === void 0) return extraKeys.every((key) => e[key] === void 0);
  return e.type === "flash" && e.flashVersion === 2 && extraKeys.slice(0, 5).every((key) => e[key] !== void 0) && /^#[0-9a-fA-F]{6}$/.test(String(e.color)) && e.envelope === void 0 && (e.blend === void 0 || e.blend === "screen");
}
function createFlash(startSeconds, polarity = "positive", style = "pulse", fps = 30) {
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || !Number.isFinite(fps) || fps < 1 || fps > 120)
    throw new Error("Flash start/fps is outside the supported range.");
  const preset = FLASH_PRESETS[style];
  return {
    type: "flash",
    flashVersion: 2,
    color: FLASH_COLORS[polarity],
    startSeconds,
    fps,
    ...preset,
    endSeconds: startSeconds + (preset.rampInFrames + preset.holdFrames + preset.rampOutFrames) / fps
  };
}
const smoothstep = (x) => {
  const p = Math.max(0, Math.min(1, x));
  return p * p * (3 - 2 * p);
};
function flashEnvelopeAt(e, at) {
  if (at < e.startSeconds || at >= e.endSeconds) return 0;
  const u = (at - e.startSeconds) * e.fps + (e.flashOffsetFrames ?? 0);
  const a = e.rampInFrames, h = e.holdFrames, o = e.rampOutFrames;
  return u < 0 ? 0 : u < a ? smoothstep(u / a) : u < a + h ? 1 : u < a + h + o ? smoothstep(1 - (u - a - h) / o) : 0;
}
const flashOpacityAt = (e, at) => e.peakOpacity * flashEnvelopeAt(e, at);
function combinedFlashRGB(effects, at) {
  const result = [0, 0, 0];
  for (const e of effects) {
    const opacity = flashOpacityAt(e, at);
    for (let i = 0; i < 3; i++) result[i] += parseInt(e.color.slice(1 + i * 2, 3 + i * 2), 16) * opacity;
  }
  return result.map((c) => Math.min(255, Math.max(0, c)));
}
const screenFlashPixel = (base, layer) => base.map((c, i) => 255 - (255 - c) * (255 - layer[i]) / 255);
function trimFlash(e, startSeconds, requestedEnd) {
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || !Number.isFinite(requestedEnd))
    throw new Error("Flash trim requires finite, non-negative timeline times.");
  const a = Math.max(2, e.rampInFrames), o = Math.max(2, e.rampOutFrames);
  const holdFrames = Math.max(0, Math.round((requestedEnd - startSeconds) * e.fps) - a - o);
  return {
    ...e,
    startSeconds,
    rampInFrames: a,
    rampOutFrames: o,
    holdFrames,
    flashOffsetFrames: 0,
    endSeconds: startSeconds + (a + holdFrames + o) / e.fps
  };
}
function projectFlashWindow(e, originalWindowStart, projectedStart, projectedEnd, speed = 1) {
  if (![originalWindowStart, projectedStart, projectedEnd, speed].every(Number.isFinite) || originalWindowStart < e.startSeconds || projectedStart < 0 || projectedEnd <= projectedStart || speed <= 0)
    throw new Error("Flash projection requires a valid surviving interval and positive playback speed.");
  return {
    ...e,
    startSeconds: projectedStart,
    endSeconds: projectedEnd,
    fps: e.fps * speed,
    flashOffsetFrames: (e.flashOffsetFrames ?? 0) + Math.max(0, originalWindowStart - e.startSeconds) * e.fps
  };
}
function flashEnvelopeExpression(e, clock = "T") {
  const u = `(((${clock})-${e.startSeconds})*${e.fps}+${e.flashOffsetFrames ?? 0})`;
  const s = (x) => `((${x})*(${x})*(3-2*(${x})))`;
  const a = e.rampInFrames, h = e.holdFrames, o = e.rampOutFrames;
  return `if(lt(${clock},${e.startSeconds})+gte(${clock},${e.endSeconds}),0,if(lt(${u},0),0,if(lt(${u},${a}),${s(`${u}/${a}`)},if(lt(${u},${a + h}),1,if(lt(${u},${a + h + o}),${s(`1-(${u}-${a + h})/${o}`)},0)))))`;
}
function flashChannelExpression(effects, channel, clock = "T") {
  const terms = effects.map((e) => `${parseInt(e.color.slice(1 + channel * 2, 3 + channel * 2), 16)}*${e.peakOpacity}*(${flashEnvelopeExpression(e, clock)})`);
  return `min(255,max(0,${terms.join("+") || "0"}))`;
}
function flashProposalEffect(proposal, id) {
  const { beatId: _beatId, wordIdx: _wordIdx, reason: _reason, origin: _origin, ...effect } = proposal;
  return { ...effect, id };
}
function proposeFlashes(beats, duration, capabilities, fps = 30) {
  if (!supportsFlashV2(capabilities)) return { effects: [], skippedReason: "Needs worker update: flashBlend:2. Smooth flashes were not substituted." };
  const selected = [];
  for (const beat of [...beats].sort((a, b) => b.score - a.score || a.onset - b.onset)) {
    if (!beat.beatId || !Number.isInteger(beat.wordIdx) || beat.wordIdx < 0 || !beat.word.trim() || !beat.reason.trim() || !Number.isFinite(beat.score) || beat.score < 0.7 || !Number.isFinite(beat.onset) || beat.onset < 0 || !["positive", "negative"].includes(beat.polarity) || beat.onset + 40 / fps > duration || selected.some((b) => b.beatId === beat.beatId || Math.abs(b.onset - beat.onset) < 1.4)) continue;
    selected.push(beat);
    if (selected.length === 4) break;
  }
  return { effects: selected.sort((a, b) => a.onset - b.onset).map((beat) => ({
    ...createFlash(beat.onset, beat.polarity, "pulse", fps),
    beatId: beat.beatId,
    wordIdx: beat.wordIdx,
    reason: beat.reason,
    origin: "auto"
  })), skippedReason: void 0 };
}
export {
  FLASH_COLORS,
  FLASH_PRESETS,
  combinedFlashRGB,
  createFlash,
  flashChannelExpression,
  flashEnvelopeAt,
  flashEnvelopeExpression,
  flashFields,
  flashOpacityAt,
  flashProposalEffect,
  isFlashV2,
  projectFlashWindow,
  proposeFlashes,
  screenFlashPixel,
  smoothstep,
  supportsFlashV2,
  trimFlash,
  validFlashFields
};
