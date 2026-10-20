import { layoutFilter } from "./framing.js";

export function segmentFramingFilter(layout, width, height, sw, sh, source, look, edit, previewAt,
  frame = (layout, w, h, sw, sh, settings, look, at, origin) => layoutFilter(layout, w, h, sw, sh, settings, look, at, false, origin),
  dynamicPunch = false) {
  if (!edit?.segments?.some(segment => segment.transform || !dynamicPunch && segment.punchScale !== undefined)) return frame(layout, width, height, sw, sh, source, look, previewAt);
  let cursor = 0;
  const spans = [];
  for (const segment of edit.segments) {
    const start = edit.version === 2 ? segment.outputStart : cursor;
    if (start > cursor) spans.push({ start: cursor, end: start });
    cursor = start + (segment.srcEnd - segment.srcStart) / (segment.speed ?? 1);
    spans.push({ start, end: cursor, transform: segment.transform, punchScale: segment.punchScale });
  }
  const settings = span => {
    const s = span.transform
      ? { ...source, ...span.transform, ...(source.tracking ? { tracking: { ...source.tracking, enabled: false } } : {}) }
      : source;
    return !dynamicPunch && span.punchScale !== undefined ? { ...s, zoom: Math.min(3,
      Math.max(s.zoom ?? 1, s.tracking?.enabled ? s.tracking.zoom : 1) * span.punchScale) } : s;
  };
  if (previewAt !== undefined) return frame(layout, width, height, sw, sh, settings(spans.find(span => previewAt >= span.start && previewAt < span.end) || {}), look, previewAt);
  // Trim BEFORE scaling, and concatenate sequential intervals. An overlay
  // waiting for a late manual interval buffers the entire full-resolution
  // default stream; stacking many such overlays can exhaust worker memory.
  const visible = spans.filter(span => Math.ceil(span.end * 30 - 1e-7) > Math.ceil(span.start * 30 - 1e-7));
  if (!visible.length) return frame(layout, width, height, sw, sh, source, look);
  const filters = [`[0:v]fps=30:start_time=0,split=${visible.length}${visible.map((_, i) => `[manualin${i}]`).join("")}`];
  const rename = (graph, index, input, output) => graph.replace(/\[([^\]]+)\]/g, (_match, label) =>
    label === "0:v" ? `[${input}]` : label === "base" ? `[${output}]` : `[${label}_${index}]`);
  visible.forEach((span, index) => {
    const first = Math.ceil(span.start * 30 - 1e-7), last = Math.ceil(span.end * 30 - 1e-7);
    filters.push(`[manualin${index}]trim=start_frame=${first}:end_frame=${last},setpts=PTS-STARTPTS[partin${index}]`);
    filters.push(rename(frame(layout, width, height, sw, sh, settings(span), look, undefined, first / 30), index, `partin${index}`, `framed${index}`));
    // Each interval owns an exact range of the global 30fps clock. Local fps
    // filters can drop a final frame at EOF; pad and bound it without cumulative
    // splice drift or changing audio/caption clocks.
    filters.push(`[framed${index}]tpad=stop_mode=clone:stop=-1,trim=end_frame=${last-first},settb=1/30,setpts=N,setsar=1,format=yuv420p[normalized${index}]`);
  });
  filters.push(`${visible.map((_, index) => `[normalized${index}]`).join("")}concat=n=${visible.length}:v=1:a=0,settb=1/30,setpts=N[base]`);
  return filters.join(";");
}
