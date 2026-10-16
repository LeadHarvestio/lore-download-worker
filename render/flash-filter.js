// Generated from shared TypeScript by scripts/sync-worker-flash-contracts.mjs.
import { flashChannelExpression } from "./flash.js";
function buildSmoothFlashFilters(input, output, effects, width, height, offset = 0, prefix = "smoothflash") {
  if (!effects.length) return { filters: [], label: input };
  const clock = `(T+${offset})`;
  const [r, g, b] = [0, 1, 2].map((channel) => flashChannelExpression(effects, channel, clock));
  const enable = effects.map((e) => `gte(t+${offset},${e.startSeconds})*lt(t+${offset},${e.endSeconds})`).join("+");
  return { label: output, filters: [
    `[${input}]format=gbrp,split=2[${prefix}base][${prefix}tinyin]`,
    `[${prefix}tinyin]scale=16:28:flags=neighbor,format=gbrp,geq=r='${r}':g='${g}':b='${b}',scale=${width}:${height}:flags=neighbor,format=gbrp[${prefix}rgb]`,
    `[${prefix}base][${prefix}rgb]blend=all_mode=screen:all_opacity=1:enable='${enable}'[${output}]`
  ] };
}
export {
  buildSmoothFlashFilters
};
