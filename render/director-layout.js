import { z } from "zod";
import { sourcePanesSchema, nameTagSchema } from "./director-motion.js";
import { directorForegroundGeometry } from "./director-geometry.js";
import { sourceSettings } from "./framing.js";
import { sourceVideoFilter } from "./video-filters.js";
import { smoothFaceTrack } from "./face-tracking-core.js";
import { trackExpression } from "./tracking-framing.js";
import { segmentFramingFilter } from "./segment-framing.js";
import { segmentAtOutput } from "./source-timing.js";

export function validateDirectorLayout(style = {}) {
  if (style.sourcePanes !== undefined) sourcePanesSchema.parse(style.sourcePanes);
  if (style.nameTags !== undefined) {
    const tags = z.array(nameTagSchema).max(4).parse(style.nameTags);
    if (new Set(tags.map(t => t.id)).size !== tags.length) throw new Error("Name tag IDs must be unique.");
    for (const tag of tags) {
      // Wire values are already output-time, projected once by the app.
      if (tag.endSeconds - tag.startSeconds > 3.001) throw new Error("Name tags may play for at most 3 seconds.");
      if (tag.tracking.mode !== "selectedFace" || !tag.tracking.track.some(p =>
        p.faceId === tag.tracking.faceId && p.confidence >= .6)) {
        throw new Error("Name tags need an explicitly selected cached face.");
      }
    }
  }
}

export function paneDefinitions(style, height) {
  if (!style.sourcePanes) return [{ key: "main", y: 0, height, mode: style.layout, source: sourceSettings(style.source) }];
  const top = Math.max(2, Math.round(height * style.sourcePanes.topPct / 100 / 2) * 2);
  const { tracking: _ignored, ...manual } = sourceSettings(style.source);
  return [["top", 0, top], ["bottom", top, height - top]].map(([key, y, ph]) => ({
    key, y, height: ph, mode: style.sourcePanes[key].mode,
    source: { ...manual, ...(style.sourcePanes[key].tracking ? { tracking: style.sourcePanes[key].tracking } : {}) },
  }));
}

// No effects here: motion capabilities remain separately gated.
export function sourcePlaneRects(style, sw, sh, width, height, edit, at) {
  const transform = segmentAtOutput(edit, at)?.segment.transform;
  return paneDefinitions(style, height).map(pane => {
    const source = transform ? { ...pane.source, ...transform, tracking: undefined } : pane.source;
    const g = directorForegroundGeometry(sw, sh, width, pane.height, pane.mode, source, [], at);
    const x = Math.max(0, Math.round(g.foregroundX)), y = Math.max(0, Math.round(g.foregroundY));
    return { x, y: pane.y + y,
      w: Math.max(0, Math.min(width, Math.round(g.foregroundX + g.foregroundWidth)) - x),
      h: Math.max(0, Math.min(pane.height, Math.round(g.foregroundY + g.foregroundHeight)) - y) };
  });
}

export function renameGraph(graph, prefix, input, output) {
  return graph.replace(/\[([^\]]+)\]/g, (_, label) =>
    label === "0:v" ? `[${input}]` : label === "base" ? `[${output}]` : `[${prefix}_${label}]`);
}

function paneFilter(layout, width, height, sw, sh, settings, look, at) {
  const geometry = directorForegroundGeometry(sw, sh, width, height, layout, settings, [], at ?? 0);
  const { cropWidth: cw, cropHeight: ch, cropX: cx, cropY: cy, foregroundWidth: fw, foregroundHeight: fh } = geometry;
  let x = String(geometry.foregroundX), y = String(geometry.foregroundY);
  const tracking = settings.tracking;
  if (tracking?.enabled && tracking.track.length && at === undefined) {
    const points = smoothFaceTrack(tracking, Math.max(tracking.endSeconds, .1));
    const zoom = Math.max(settings.zoom, tracking.zoom);
    const vh = layout === "fill" ? height : Math.min(height, fh / zoom);
    x = `min(max(${width / 2}-${fw}*((${sw}*(${trackExpression(points, "x")})-${cx})/${cw}),${Math.min(0, width - fw)}),${Math.max(0, (width - fw) / 2)})`;
    y = `min(max(${height / 2}-${fh}*((${sh}*(${trackExpression(points, "y")})-${cy})/${ch}),${(height - vh) / 2 + vh - fh}),${(height - vh) / 2})`;
  }
  const crop = `crop=${cw}:${ch}:${cx}:${cy}`;
  const background = layout === "blurfit"
    ? (() => {
      // Pane backgrounds follow the saved manual position, never the face camera.
      const bg = directorForegroundGeometry(sw, sh, width, height, "fill", { ...settings, tracking: undefined, zoom: 1 }, [], 0);
      return `[bginput]scale=${bg.foregroundWidth}:${bg.foregroundHeight},setsar=1[bgscaled];` +
        `color=black:s=${width}x${height}:r=30[bgcanvas];[bgcanvas][bgscaled]overlay=x=${bg.foregroundX}:y=${bg.foregroundY}:shortest=1,` +
        `gblur=sigma=${10 * width / 1080},eq=brightness=-0.12:saturation=1.1[panebg]`;
    })()
    : `color=black:s=${width}x${height}:r=30[panebg]`;
  return `[0:v]fps=30,${crop}${layout === "blurfit" ? ",split=2[fginput][bginput]" : "[fginput]"};${background};` +
    `[fginput]${sourceVideoFilter(look)}scale=${fw}:${fh},setsar=1[panefg];` +
    `[panebg][panefg]overlay=x='${x}':y='${y}':shortest=1[base]`;
}

export function directorLayoutFilter(style, width, height, sw, sh, source, edit, at) {
  if (!style.sourcePanes) return segmentFramingFilter(style.layout, width, height, sw, sh, source, style.videoFilter, edit, at);
  const panes = paneDefinitions({ ...style, source }, height);
  const filters = ["[0:v]split=2[topinput][bottominput]"];
  for (const pane of panes) {
    const graph = segmentFramingFilter(pane.mode, width, pane.height, sw, sh, pane.source, style.videoFilter, edit, at, paneFilter);
    filters.push(renameGraph(graph, pane.key, `${pane.key}input`, `${pane.key}base`));
  }
  filters.push("[topbase][bottombase]vstack=inputs=2[base]");
  return filters.join(";");
}
