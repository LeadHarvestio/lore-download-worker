import { z } from "zod";
import { faceTrackingSchema } from "./face-tracking-core.js";
const unit = () => z.number().finite().min(0).max(1);
const envelope = z.object({ attack: unit(), hold: unit(), decay: unit() }).strict()
  .refine(e => Math.abs(e.attack + e.hold + e.decay - 1) < .001);
const timed = { startSeconds: z.number().finite().min(0).max(1800), endSeconds: z.number().finite().min(0).max(1800) };
export const effectSchema = z.object({
  ...timed, id: z.string().max(80).optional(), type: z.enum(["flash", "zoom", "shake", "flicker"]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), opacity: unit().optional(),
  strengthPct: z.number().finite().min(0).max(3).optional(),
  speedHz: z.number().finite().min(.1).max(2).optional(),
  amount: z.number().finite().min(0).max(.08).optional(), glow: unit().optional(),
  blend: z.enum(["normal", "screen", "overlay", "multiply"]).optional(), envelope: envelope.optional(),
  fromScale: z.number().finite().min(1).max(1.5).optional(), toScale: z.number().finite().min(1).max(1.5).optional(),
  easing: z.enum(["linear", "easeOut", "easeInOut"]).optional(),
  anchor: z.object({ x: unit(), y: unit() }).strict().optional(),
}).strict().refine(e => e.endSeconds > e.startSeconds)
  .refine(e => (e.type === "flash" || e.blend === undefined && e.envelope === undefined) &&
    (e.type === "zoom" ? e.fromScale !== undefined && e.toScale !== undefined && e.easing !== undefined && e.anchor !== undefined
      : e.fromScale === undefined && e.toScale === undefined && e.easing === undefined && e.anchor === undefined));
const pane = z.object({ mode: z.enum(["fill", "blurfit"]), tracking: faceTrackingSchema.optional() }).strict();
export const panesSchema = z.object({ topPct: z.number().finite().min(40).max(65), top: pane, bottom: pane }).strict();
export const tagSchema = z.object({
  ...timed, id: z.string().uuid(), text: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/), tracking: faceTrackingSchema,
}).strict().refine(t => t.endSeconds > t.startSeconds && t.endSeconds - t.startSeconds <= 3 &&
  t.tracking.enabled && !!t.tracking.faceId);
export function validateDirectorStyle(style) {
  if (style.effects) z.array(effectSchema).max(30).parse(style.effects);
  if (style.sourcePanes) panesSchema.parse(style.sourcePanes);
  if (style.nameTags) z.array(tagSchema).max(4).parse(style.nameTags);
}
export function flashOpacity(e, at) {
  if (at < e.startSeconds || at >= e.endSeconds) return 0;
  const opacity = e.opacity ?? .25, p = (at - e.startSeconds) / (e.endSeconds - e.startSeconds);
  if (!e.envelope) return opacity;
  const { attack, hold, decay } = e.envelope;
  return opacity * Math.max(0, Math.min(1, attack > 0 && p < attack ? p / attack :
    p <= attack + hold ? 1 : decay > 0 ? (1 - p) / decay : 0));
}
export function zoomScale(e, at) {
  if (at < e.startSeconds || at >= e.endSeconds) return 1;
  const p = Math.min(1, (at - e.startSeconds) / Math.min(.25, e.endSeconds - e.startSeconds));
  const ease = e.easing === "easeOut" ? 1 - (1 - p) ** 3 : e.easing === "easeInOut" ? p * p * (3 - 2 * p) : p;
  return e.fromScale + (e.toScale - e.fromScale) * ease;
}
export function zoomExpression(effects, time) {
  // Last active zoom wins. Bounded scale prevents multiplicative overlap growth.
  let expression = "1";
  for (const e of effects.filter(e => e.type === "zoom")) {
    const p = `min(max((${time}-${e.startSeconds})/${Math.min(.25, e.endSeconds-e.startSeconds)},0),1)`;
    const ease = e.easing === "easeOut" ? `(1-pow(1-${p},3))` : e.easing === "easeInOut" ? `(${p}*${p}*(3-2*${p}))` : p;
    expression = `if(gte(${time},${e.startSeconds})*lt(${time},${e.endSeconds}),${e.fromScale}+${e.toScale-e.fromScale}*${ease},${expression})`;
  }
  return expression;
}
