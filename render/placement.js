// Geometry-only placement, not face recognition. Prefer unused blurfit bands.
import { foregroundGeometry } from "./framing.js";
export function headlinePosition({ sourceWidth, sourceHeight, width, height, headline, style }) {
  const margin = Math.round(width * .025);
  const box = headline.visibleBox || { x: 0, y: 0, width: headline.width, height: headline.height };
  const clamp = y => Math.max(margin - box.y, Math.min(height - margin - box.height - box.y, y));
  if (!style.headline.autoPosition) return clamp(height * style.headline.yPct / 100 - headline.height / 2);
  if (style.layout === "blurfit") {
    const foreground = foregroundGeometry(sourceWidth, sourceHeight, width, height, style.source);
    const contentTop = Math.max(0, (height - foreground.height) / 2);
    if (contentTop >= box.height + margin * 2) {
      // Align the visible box just above the sharp source, leaving a small safe gap.
      return clamp(contentTop - margin - box.height - box.y);
    }
  }
  // Portrait/fill has no guaranteed empty band. Prefer the top edge, never the center.
  return margin - box.y;
}

export function previewWords(words, at) {
  return words.map(w => ({ ...w, start: w.start - at, end: w.end - at }));
}
