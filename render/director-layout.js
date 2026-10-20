import { z } from "zod";
import { sourcePanesSchema, nameTagSchema } from "./director-motion.js";
import { directorForegroundGeometry } from "./director-geometry.js";
import { sourceSettings } from "./framing.js";
import { sourceVideoFilter } from "./video-filters.js";
import { smoothFaceTrack } from "./face-tracking-core.js";
import { trackExpression } from "./tracking-framing.js";
import { segmentFramingFilter } from "./segment-framing.js";
import { segmentAtOutput } from "./source-timing.js";
import { zoomExpression, validateMotionEffects } from "./motion-effects.js";
import { affineFilter } from "./affine-transform.js";
import { layoutFilter } from "./framing.js";

export function validateDirectorLayout(style = {}) {
  validateMotionEffects(style);
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

export function sourcePlaneRects(style, sw, sh, width, height, edit, at) {
  const segment = segmentAtOutput(edit, at)?.segment;
  const transform = segment?.transform;
  return paneDefinitions(style, height).map(pane => {
    let source = transform ? { ...pane.source, ...transform, tracking: undefined } : pane.source;
    if (segment?.punchScale !== undefined) source = { ...source, zoom: Math.min(3,
      Math.max(source.zoom ?? 1, source.tracking?.enabled ? source.tracking.zoom : 1) * segment.punchScale) };
    const g = directorForegroundGeometry(sw, sh, width, pane.height, pane.mode, source, style.effects || [], at);
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

function paneFilter(layout, width, height, sw, sh, settings, look, at, origin = 0, effects = [], single = false, edit, mask = false) {
  const geometry = directorForegroundGeometry(sw, sh, width, height, layout, settings, [], at ?? 0);
  const { cropWidth: cw, cropHeight: ch, cropX: cx, cropY: cy, foregroundWidth: fw, foregroundHeight: fh } = geometry;
  const time = at === undefined ? `(t+${origin})` : String(at);
  const tracking = settings.tracking;
  // Punches share the foreground stream. One full-resolution branch per cut
  // would buffer entire clips at every overlay and exhaust memory.
  const baseZoom = Math.max(settings.zoom ?? 1, tracking?.enabled ? tracking.zoom : 1);
  let punch = "1", cursor = 0;
  for (const segment of edit?.segments || []) {
    const start = edit.version === 2 ? segment.outputStart : cursor;
    cursor = start + (segment.srcEnd-segment.srcStart)/(segment.speed ?? 1);
    if (segment.punchScale !== undefined) punch = `if(gte(${time},${start})*lt(${time},${cursor}),${Math.min(3,baseZoom*segment.punchScale)/baseZoom},${punch})`;
  }
  const pw = `max(2,round(${fw}*(${punch})/2)*2)`, ph = `max(2,round(${fh}*(${punch})/2)*2)`;
  let x = `W*${settings.xPct/100}-(${pw})/2`, y = `H*${settings.yPct/100}-(${ph})/2`;
  if (tracking?.enabled && tracking.track.length) {
    const points = smoothFaceTrack(tracking, Math.max(tracking.endSeconds, .1));
    const zoom = Math.max(settings.zoom, tracking.zoom);
    const vh = layout === "fill" ? height : Math.min(height, fh / zoom);
    x = `min(max(${width/2}-(${pw})*((${sw}*(${trackExpression(points,"x",time)})-${cx})/${cw}),min(0,${width}-(${pw}))),max(0,(${width}-(${pw}))/2))`;
    y = `min(max(${height/2}-(${ph})*((${sh}*(${trackExpression(points,"y",time)})-${cy})/${ch}),${(height-vh)/2+vh}-(${ph})),${(height-vh)/2})`;
  }
  const zooms = effects.filter(e => e.type === "zoom"), scale = zoomExpression(zooms, time);
  let ax = ".5", ay = ".35";
  for (const e of zooms) {
    const active = `gte(${time},${e.startSeconds})*lt(${time},${e.endSeconds})`;
    ax = `if(${active},${e.anchor.x},${ax})`; ay = `if(${active},${e.anchor.y},${ay})`;
  }
  const crop = `crop=${cw}:${ch}:${cx}:${cy}`;
  const background = layout === "blurfit" && !mask
    ? (() => {
      if (single) return `[bginput]scale=${Math.round(width/8)*2}:${Math.round(height/8)*2}:force_original_aspect_ratio=increase,` +
        `crop=${Math.round(width/8)*2}:${Math.round(height/8)*2},boxblur=${Math.round(10*width/1080)}:6,` +
        `eq=brightness=-0.12:saturation=1.1,scale=${width}:${height}[panebg]`;
      // Pane backgrounds follow the saved manual position, never the face camera.
      const bg = directorForegroundGeometry(sw, sh, width, height, "fill", { ...settings, tracking: undefined, zoom: 1 }, [], 0);
      return `[bginput]scale=${bg.foregroundWidth}:${bg.foregroundHeight},setsar=1[bgscaled];` +
        `color=black:s=${width}x${height}:r=30[bgcanvas];[bgcanvas][bgscaled]overlay=x=${bg.foregroundX}:y=${bg.foregroundY}:shortest=1,` +
        `gblur=sigma=${10 * width / 1080},eq=brightness=-0.12:saturation=1.1[panebg]`;
    })()
    : `color=black:s=${width}x${height}:r=30[panebg]`;
  const overlayPosition = settings.affine
    ? `x='(${x})-(max(2,trunc((${pw})*(${scale})/2)*2)-(${pw}))*(${ax})+max(2,trunc((${pw})*(${scale})/2)*2)/2-w/2':y='(${y})-(max(2,trunc((${ph})*(${scale})/2)*2)-(${ph}))*(${ay})+max(2,trunc((${ph})*(${scale})/2)*2)/2-h/2'`
    : `x='(${x})-(w-(${pw}))*(${ax})':y='(${y})-(h-(${ph}))*(${ay})'`;
  return `[0:v]fps=30,${crop}${layout === "blurfit" && !mask ? ",split=2[fginput][bginput]" : "[fginput]"};${background};` +
    `[fginput]${sourceVideoFilter(look)}scale=w='max(2,trunc((${pw})*(${scale})/2)*2)':h='max(2,trunc((${ph})*(${scale})/2)*2)':eval=frame,setsar=1${affineFilter(settings.affine)}[panefg];` +
    `[panebg][panefg]overlay=${overlayPosition}:eval=frame:shortest=1[base]`;
}

export function directorLayoutFilter(style, width, height, sw, sh, source, edit, at, mask = false) {
  const motion = style.effects?.some(e => e.type === "zoom") || edit?.segments.some(s => s.punchScale !== undefined);
  const frame = (layout, w, h, sw, sh, settings, look, at, origin) =>
    paneFilter(layout, w, h, sw, sh, settings, look, at, origin, style.effects || [], !style.sourcePanes, edit, mask);
  if (!style.sourcePanes) return segmentFramingFilter(style.layout, width, height, sw, sh, source, style.videoFilter, edit, at,
    motion ? frame : mask ? (layout, w, h, sw, sh, settings, look, at, origin) =>
      layoutFilter(layout, w, h, sw, sh, settings, look, at, true, origin) : undefined, !!motion);
  const panes = paneDefinitions({ ...style, source }, height);
  const filters = ["[0:v]split=2[topinput][bottominput]"];
  for (const pane of panes) {
    const graph = segmentFramingFilter(pane.mode, width, pane.height, sw, sh, pane.source, style.videoFilter, edit, at, frame, true);
    filters.push(renameGraph(graph, pane.key, `${pane.key}input`, `${pane.key}base`));
  }
  filters.push("[topbase][bottombase]vstack=inputs=2[base]");
  return filters.join(";");
}
