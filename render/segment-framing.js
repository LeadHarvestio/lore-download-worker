import { layoutFilter } from "./framing.js";

export function segmentFramingFilter(layout, width, height, sw, sh, source, look, edit, previewAt, frame = layoutFilter, dynamicPunch = false) {
  if (!edit?.segments?.some(segment => segment.transform || !dynamicPunch && segment.punchScale !== undefined)) return frame(layout, width, height, sw, sh, source, look, previewAt);
  let cursor = 0;
  const spans = edit.segments.map(segment => {
    const start = cursor;
    cursor += (segment.srcEnd - segment.srcStart) / (segment.speed ?? 1);
    return { start, end: cursor, transform: segment.transform, punchScale: segment.punchScale };
  });
  const settings = span => {
    const s = span.transform
      ? { ...source, ...span.transform, ...(source.tracking ? { tracking: { ...source.tracking, enabled: false } } : {}) }
      : source;
    return !dynamicPunch && span.punchScale !== undefined ? { ...s, zoom: Math.min(3,
      Math.max(s.zoom ?? 1, s.tracking?.enabled ? s.tracking.zoom : 1) * span.punchScale) } : s;
  };
  if (previewAt !== undefined) return frame(layout, width, height, sw, sh, settings(spans.find(span => previewAt < span.end) || spans.at(-1)), look, previewAt);
  const manual = spans.filter(span => span.transform || !dynamicPunch && span.punchScale !== undefined);
  // Render the default camera path once. Only changed intervals get another
  // framing pass; splitting a tracked clip never duplicates its full expression.
  const filters = [`[0:v]split=${manual.length + 1}[defaultin]${manual.map((_, i) => `[manualin${i}]`).join("")}`];
  const rename = (graph, index, input, output) => graph.replace(/\[([^\]]+)\]/g, (_match, label) =>
    label === "0:v" ? `[${input}]` : label === "base" ? `[${output}]` : `[${label}_${index}]`);
  filters.push(rename(frame(layout, width, height, sw, sh, source, look), "default", "defaultin", "defaultbase"));
  let current = "defaultbase";
  manual.forEach((span, index) => {
    filters.push(`[manualin${index}]trim=start=${span.start}:end=${span.end},setpts=PTS-STARTPTS[partin${index}]`);
    filters.push(rename(frame(layout, width, height, sw, sh, settings(span), look, undefined, span.start), index, `partin${index}`, `framed${index}`));
    filters.push(`[framed${index}]setpts=PTS-STARTPTS+${span.start}/TB[placed${index}]`);
    const next = index === manual.length - 1 ? "base" : `replaced${index}`;
    filters.push(`[${current}][placed${index}]overlay=0:0:enable='gte(t,${span.start})*lt(t,${span.end})':eof_action=pass:repeatlast=0[${next}]`);
    current = next;
  });
  return filters.join(";");
}
