import { z } from "zod";
import { motionEffectFields, validMotionFields } from "./director-motion.js";

const time = () => z.number().finite().min(0).max(1800);
const unit = () => z.number().finite().min(0).max(1);
// Additive only: do not normalize/default old effect fields.
export const effectSchema = z.object({
  id: z.string().max(80).optional(),
  type: z.enum(["flash", "zoom", "shake", "flicker"]),
  startSeconds: time(), endSeconds: time(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  opacity: unit().optional(), strengthPct: z.number().finite().min(0).max(3).optional(),
  speedHz: z.number().finite().min(.1).max(2).optional(),
  amount: z.number().finite().min(0).max(.08).optional(), glow: unit().optional(),
  ...motionEffectFields,
}).strict().refine(e => e.endSeconds > e.startSeconds).refine(validMotionFields);

export function validateMotionEffects(style = {}) {
  if (style.effects !== undefined) z.array(effectSchema).max(30).parse(style.effects);
}

export function zoomExpression(effects, time) {
  let expression = "1";
  for (const e of effects.filter(e => e.type === "zoom")) {
    const p = `min(max((${time}-${e.startSeconds})/${Math.min(.25, e.endSeconds-e.startSeconds)},0),1)`;
    const ease = e.easing === "easeOut" ? `(1-pow(1-${p},3))` :
      e.easing === "easeInOut" ? `(${p}*${p}*(3-2*${p}))` : p;
    expression = `if(gte(${time},${e.startSeconds})*lt(${time},${e.endSeconds}),${e.fromScale}+${e.toScale-e.fromScale}*${ease},${expression})`;
  }
  return expression;
}
