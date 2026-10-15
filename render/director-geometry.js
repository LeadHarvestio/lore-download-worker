// shared/face-tracking.ts
import { z } from "zod";
var facePointSchema = z.object({
  t: z.number().finite().min(0).max(1800),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  w: z.number().finite().positive().max(1),
  h: z.number().finite().positive().max(1),
  confidence: z.number().finite().min(0).max(1),
  faceId: z.string().min(1).max(40)
}).strict().refine((p) => p.x + p.w <= 1.001 && p.y + p.h <= 1.001, "Face bounds leave the source frame.");
var faceTrackingSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["autoFace", "selectedFace"]),
  zoom: z.number().finite().min(1).max(2.5),
  smoothness: z.number().finite().min(0).max(1),
  followSpeed: z.number().finite().min(0.5).max(2.5).optional(),
  deadZonePct: z.number().finite().min(0).max(20),
  faceId: z.string().max(40).optional(),
  startSeconds: z.number().finite().min(0).max(1800),
  endSeconds: z.number().finite().positive().max(1800),
  track: z.array(facePointSchema).max(600)
}).strict().superRefine((value, ctx) => {
  if (value.endSeconds <= value.startSeconds) ctx.addIssue({ code: "custom", message: "Tracking end must follow its start." });
  value.track.forEach((p, i) => {
    if (i && p.t <= value.track[i - 1].t) ctx.addIssue({ code: "custom", message: "Tracking times must strictly increase." });
  });
});
var clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function smoothFaceTrack(settings, duration, manual = { x: 0.5, y: 0.5 }) {
  const input = settings.track.filter((p) => p.confidence >= 0.5 && p.t <= duration);
  if (!input.length) return [{ t: 0, ...manual }, { t: duration, ...manual }];
  const result = [], step = Math.max(0.1, duration / 599);
  let previous = { x: input[0].x + input[0].w / 2, y: input[0].y + input[0].h / 2 }, index = 0;
  const velocity = { x: 0, y: 0 };
  const dead = settings.deadZonePct / 100;
  const speed = clamp(settings.followSpeed ?? 1, 0.5, 2.5);
  const response = (0.18 + settings.smoothness * 0.65) / speed;
  for (let t = 0; t <= duration + 1e-5 && result.length < 600; t += step) {
    while (index + 1 < input.length && input[index + 1].t <= t) index++;
    const a = input[index], b = input[index + 1], age = t - a.t;
    let target = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    if (b && b.t - a.t <= 1 && t >= a.t) {
      const f = clamp((t - a.t) / (b.t - a.t), 0, 1);
      target = { x: target.x + (b.x + b.w / 2 - target.x) * f, y: target.y + (b.y + b.h / 2 - target.y) * f };
    } else if (age > 0.8) {
      const f = clamp((age - 0.8) / 0.7, 0, 1);
      target = { x: target.x + (manual.x - target.x) * f, y: target.y + (manual.y - target.y) * f };
    }
    if (t < settings.startSeconds || t > settings.endSeconds) target = manual;
    if (t > 0) {
      const iterations = Math.ceil(step * 60), dt = step / iterations;
      for (let n = 0; n < iterations; n++) {
        for (const key of ["x", "y"]) {
          const delta = target[key] - previous[key];
          const error = Math.sign(delta) * Math.max(0, Math.abs(delta) - dead);
          const acceleration = clamp(error / (response * response) - 2 * velocity[key] / response, -1.2 * speed * speed, 1.2 * speed * speed);
          velocity[key] = clamp(velocity[key] + acceleration * dt, -0.45 * speed, 0.45 * speed);
          previous[key] = clamp(previous[key] + velocity[key] * dt, 0, 1);
        }
      }
    }
    result.push({ t: Math.min(duration, t), x: clamp(previous.x, 0, 1), y: clamp(previous.y, 0, 1) });
  }
  if (result.at(-1).t < duration) result[result.length - 1] = { ...result.at(-1), t: duration };
  return result;
}
function trackedForegroundGeometry(sw, sh, width, height, layout, source, tracking, camera) {
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const left = source.cropLeftPct ?? 0, top = source.cropTopPct ?? 0;
  const cropWidth = Math.max(2, Math.floor(sw * (1 - (left + (source.cropRightPct ?? 0)) / 100) / 2) * 2);
  const cropHeight = Math.max(2, Math.floor(sh * (1 - (top + (source.cropBottomPct ?? 0)) / 100) / 2) * 2);
  const cropX = Math.floor(sw * left / 100 / 2) * 2, cropY = Math.floor(sh * top / 100 / 2) * 2;
  const zoom = Math.max(source.zoom ?? 1, tracking.zoom);
  const fit = layout === "fill" ? Math.max(width / cropWidth, height / cropHeight) : Math.min(width / cropWidth, height / cropHeight);
  const foregroundWidth = even(cropWidth * fit * zoom), foregroundHeight = even(cropHeight * fit * zoom);
  const focusX = (camera.x * sw - cropX) / cropWidth, focusY = (camera.y * sh - cropY) / cropHeight;
  const viewportHeight = layout === "fill" ? height : Math.min(height, foregroundHeight / zoom);
  const minX = Math.min(0, width - foregroundWidth), maxX = Math.max(0, (width - foregroundWidth) / 2);
  const minY = (height - viewportHeight) / 2 + viewportHeight - foregroundHeight, maxY = (height - viewportHeight) / 2;
  const foregroundX = clamp(width / 2 - foregroundWidth * focusX, minX, maxX);
  const foregroundY = clamp(height / 2 - foregroundHeight * focusY, minY, maxY);
  return {
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    foregroundWidth,
    foregroundHeight,
    foregroundX,
    foregroundY,
    centerX: foregroundX + foregroundWidth / 2,
    centerY: foregroundY + foregroundHeight / 2
  };
}
function cameraAt(track, t) {
  if (!track.length) return { t, x: 0.5, y: 0.5 };
  const i = track.findIndex((p) => p.t >= t);
  if (i <= 0) return { ...i === -1 ? track.at(-1) : track[0], t };
  const a = track[i - 1], b = track[i], f = clamp((t - a.t) / Math.max(1e-3, b.t - a.t), 0, 1);
  return { t, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

// shared/director-motion.ts
import { z as z2 } from "zod";
var unit = () => z2.number().finite().min(0).max(1);
var flashEnvelopeSchema = z2.object({ attack: unit(), hold: unit(), decay: unit() }).strict().refine((e) => Math.abs(e.attack + e.hold + e.decay - 1) < 1e-3, "Envelope fractions must sum to 1.");
var motionEffectFields = {
  blend: z2.enum(["normal", "screen", "overlay", "multiply"]).optional(),
  envelope: flashEnvelopeSchema.optional(),
  fromScale: z2.number().finite().min(1).max(1.5).optional(),
  toScale: z2.number().finite().min(1).max(1.5).optional(),
  easing: z2.enum(["linear", "easeOut", "easeInOut"]).optional(),
  anchor: z2.object({ x: unit(), y: unit() }).strict().optional()
};
function zoomScale(e, at) {
  if (at < e.startSeconds || at >= e.endSeconds) return 1;
  const p = Math.min(1, (at - e.startSeconds) / Math.min(0.25, e.endSeconds - e.startSeconds));
  const ease = e.easing === "easeOut" ? 1 - (1 - p) ** 3 : e.easing === "easeInOut" ? p * p * (3 - 2 * p) : p;
  return (e.fromScale ?? 1) + ((e.toScale ?? 1) - (e.fromScale ?? 1)) * ease;
}
var pane = z2.object({ mode: z2.enum(["fill", "blurfit"]), tracking: faceTrackingSchema.optional() }).strict();
var sourcePanesSchema = z2.object({
  topPct: z2.number().finite().min(40).max(65),
  top: pane,
  bottom: pane
}).strict();
var nameTagSchema = z2.object({
  id: z2.string().uuid(),
  text: z2.string().trim().min(1).max(40),
  startSeconds: z2.number().finite().min(0).max(1800),
  endSeconds: z2.number().finite().min(0).max(1800),
  color: z2.string().regex(/^#[0-9a-fA-F]{6}$/),
  tracking: faceTrackingSchema
}).strict().refine((t) => t.endSeconds > t.startSeconds && t.tracking.enabled && !!t.tracking.faceId, "Name tags need an explicitly selected enabled face and a positive duration.");

// shared/source-edit.ts
import { z as z3 } from "zod";
var sourceEditSchema = z3.object({
  segments: z3.array(z3.object({
    punchScale: z3.number().finite().min(1).max(1.15).optional(),
    srcStart: z3.number().finite().min(0).max(1800),
    srcEnd: z3.number().finite().positive().max(1800),
    speed: z3.number().finite().min(0.25).max(4).optional(),
    transform: z3.object({
      xPct: z3.number().finite().min(0).max(100).optional(),
      yPct: z3.number().finite().min(0).max(100).optional(),
      zoom: z3.number().finite().min(1).max(3).optional(),
      cropLeftPct: z3.number().finite().min(0).max(40).optional(),
      cropRightPct: z3.number().finite().min(0).max(40).optional(),
      cropTopPct: z3.number().finite().min(0).max(40).optional(),
      cropBottomPct: z3.number().finite().min(0).max(40).optional()
    }).strict().optional()
  }).strict()).min(1).max(40)
}).strict().superRefine((edit, ctx) => {
  let previousEnd = 0;
  edit.segments.forEach((segment, index) => {
    if (segment.srcEnd <= segment.srcStart || segment.srcStart < previousEnd) {
      ctx.addIssue({ code: "custom", path: ["segments", index], message: "Segments must be ordered, non-overlapping and have positive duration." });
    }
    previousEnd = segment.srcEnd;
  });
  if (outputDuration(edit) > 1800) ctx.addIssue({ code: "custom", message: "Edited output exceeds 30 minutes." });
});
function outputDuration(edit) {
  return edit.segments.reduce((total, segment) => total + (segment.srcEnd - segment.srcStart) / (segment.speed ?? 1), 0);
}
function segmentAtOutput(edit, at) {
  if (!edit) return void 0;
  let cursor = 0;
  for (let index = 0; index < edit.segments.length; index++) {
    const segment = edit.segments[index];
    cursor += (segment.srcEnd - segment.srcStart) / (segment.speed ?? 1);
    if (at < cursor || index === edit.segments.length - 1) return { index, segment };
  }
  return void 0;
}

// shared/director-geometry.ts
var cameraCache = /* @__PURE__ */ new WeakMap();
function directorForegroundGeometry(sw, sh, width, height, layout, source, effects, at, trackingAt = at) {
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const cropWidth = Math.max(2, Math.floor(sw * (1 - ((source.cropLeftPct ?? 0) + (source.cropRightPct ?? 0)) / 100) / 2) * 2);
  const cropHeight = Math.max(2, Math.floor(sh * (1 - ((source.cropTopPct ?? 0) + (source.cropBottomPct ?? 0)) / 100) / 2) * 2);
  const cropX = Math.floor(sw * (source.cropLeftPct ?? 0) / 100 / 2) * 2;
  const cropY = Math.floor(sh * (source.cropTopPct ?? 0) / 100 / 2) * 2;
  const fit = (layout === "fill" ? Math.max(width / cropWidth, height / cropHeight) : Math.min(width / cropWidth, height / cropHeight)) * (source.zoom ?? 1);
  const fw = even(cropWidth * fit), fh = even(cropHeight * fit);
  const tracking = source.tracking;
  let geometry = {
    cropWidth,
    cropHeight,
    cropX,
    cropY,
    foregroundWidth: fw,
    foregroundHeight: fh,
    centerX: width * (source.xPct ?? 50) / 100,
    centerY: height * (source.yPct ?? 50) / 100,
    foregroundX: width * (source.xPct ?? 50) / 100 - fw / 2,
    foregroundY: height * (source.yPct ?? 50) / 100 - fh / 2
  };
  if (tracking?.enabled && tracking.track.length) {
    let camera = cameraCache.get(tracking);
    if (!camera) {
      camera = smoothFaceTrack(tracking, Math.max(tracking.endSeconds, 0.1));
      cameraCache.set(tracking, camera);
    }
    geometry = trackedForegroundGeometry(sw, sh, width, height, layout === "fill" ? "fill" : "blurfit", source, tracking, cameraAt(camera, trackingAt));
  }
  const zoom = effects.filter((e) => e.type === "zoom" && at >= e.startSeconds && at < e.endSeconds).at(-1);
  if (!zoom) return geometry;
  const scale = zoomScale(zoom, at);
  const newW = Math.max(2, Math.trunc(geometry.foregroundWidth * scale / 2) * 2);
  const newH = Math.max(2, Math.trunc(geometry.foregroundHeight * scale / 2) * 2);
  return {
    ...geometry,
    foregroundWidth: newW,
    foregroundHeight: newH,
    centerX: geometry.foregroundX - (newW - geometry.foregroundWidth) * (zoom.anchor?.x ?? 0.5) + newW / 2,
    centerY: geometry.foregroundY - (newH - geometry.foregroundHeight) * (zoom.anchor?.y ?? 0.35) + newH / 2,
    foregroundX: geometry.foregroundX - (newW - geometry.foregroundWidth) * (zoom.anchor?.x ?? 0.5),
    foregroundY: geometry.foregroundY - (newH - geometry.foregroundHeight) * (zoom.anchor?.y ?? 0.35)
  };
}
function nameTagPosition(tag, style, sw, sh, width, height, at) {
  if (at < tag.startSeconds || at >= tag.endSeconds) return null;
  const point = tag.tracking.track.filter((p) => p.faceId === tag.tracking.faceId && p.confidence >= 0.6).reduce((best, p) => !best || Math.abs(p.t - at) < Math.abs(best.t - at) ? p : best, null);
  if (!point || Math.abs(point.t - at) > 0.5) return null;
  const panes = style.sourcePanes;
  const topHeight = Math.max(2, Math.round(height * (panes?.topPct ?? 58) / 100 / 2) * 2);
  const pane2 = panes ? panes.top.tracking?.faceId === tag.tracking.faceId ? "top" : panes.bottom.tracking?.faceId === tag.tracking.faceId || !panes.bottom.tracking ? "bottom" : "top" : null;
  const ph = pane2 === "top" ? topHeight : pane2 === "bottom" ? height - topHeight : height;
  const py = pane2 === "bottom" ? topHeight : 0;
  const { tracking: _ignored, ...manual } = style.source || {};
  let source = pane2 ? { ...manual, ...panes[pane2].tracking ? { tracking: panes[pane2].tracking } : {} } : style.source || {};
  const segment = style.sourceEdit ? segmentAtOutput(style.sourceEdit, at)?.segment : void 0;
  if (segment?.transform) source = { ...source, ...segment.transform, ...source.tracking ? { tracking: { ...source.tracking, enabled: false } } : {} };
  if (segment?.punchScale) source = { ...source, zoom: Math.min(3, Math.max(source.zoom ?? 1, source.tracking?.enabled ? source.tracking.zoom : 1) * segment.punchScale) };
  const geometry = directorForegroundGeometry(sw, sh, width, ph, pane2 ? panes[pane2].mode : style.layout, source, style.effects || [], at);
  const x = geometry.foregroundX + ((point.x + point.w / 2) * sw - geometry.cropX) / geometry.cropWidth * geometry.foregroundWidth;
  const y = py + geometry.foregroundY + (point.y * sh - geometry.cropY) / geometry.cropHeight * geometry.foregroundHeight;
  if (x < 0 || x > width || y < py || y > py + ph) return null;
  return {
    x: Math.max(width * 0.16, Math.min(width * 0.84, x)),
    y: Math.max(height * 0.12, Math.min(height * 0.74, y - height * 0.075))
  };
}
export {
  directorForegroundGeometry,
  nameTagPosition
};
