import { z } from "zod";

// Same strict per-sound schema as shared/auto-director.ts in the app.
export const voiceDuckingSchema = z.object({
  attenuationDb: z.number().finite().min(-12).max(-3),
  attackMs: z.number().int().min(10).max(100),
  releaseMs: z.number().int().min(50).max(500),
  durationSeconds: z.number().finite().min(.1).max(1),
  leadSeconds: z.number().finite().min(0).max(.1),
}).strict();

/** Accept output-time words only. The app has already projected source cuts.
 * Each selected SFX gets its own envelope; voice/music are never inputs here.
 * Hold for the whole word (at least durationSeconds), then release.
 */
export function speechDuckingFilter(duck, words, offset, length) {
  if (duck === undefined) return "";
  voiceDuckingSchema.parse(duck);
  if (!Array.isArray(words)) throw new Error("Speech ducking requires saved output-time words; no automatic transcription.");
  const attack = duck.attackMs / 1000, release = duck.releaseMs / 1000;
  // The 10ms frame gate is deliberately bounded at 44.1kHz, after resampling.
  const windows = words.filter(w => Number.isFinite(w.start) && Number.isFinite(w.end) &&
    w.start >= 0 && w.end > w.start && (w.word ?? w.text ?? "").trim() &&
    !/^\s*\[.*\]\s*$/.test(w.word ?? w.text ?? ""))
    .map(w => ({ start: w.start - duck.leadSeconds - attack,
      end: Math.max(w.end, w.start + duck.durationSeconds) }))
    .filter(w => w.end + release > offset && w.start < offset + length)
    .sort((a, b) => a.start - b.start);
  // Merge fully overlapping holds. This bounds graph size for dense transcripts.
  const merged = [];
  for (const w of windows) {
    const prev = merged.at(-1);
    if (prev && w.start <= prev.end - attack) prev.end = Math.max(prev.end, w.end);
    else merged.push({ ...w });
  }
  if (!merged.length) return "";
  const depth = 1 - Math.pow(10, duck.attenuationDb / 20);
  const pieces = merged.map(w =>
    `max(0,min(1,min((t+${offset}-(${w.start}))/${attack},1-(t+${offset}-${w.end})/${release})))`);
  // Balanced expression avoids parser nesting limits on long clips.
  const maximum = values => values.length === 1 ? values[0] :
    `max(${maximum(values.slice(0, values.length >> 1))},${maximum(values.slice(values.length >> 1))})`;
  return `,asetnsamples=n=441:p=0,volume='1-${depth}*${maximum(pieces)}':eval=frame`;
}
