// Generated from app shared/face-tracking.ts; keep smoothing/geometry in parity.
import { z } from "zod";
const facePointSchema = z.object({
  t: z.number().finite().min(0).max(1800),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  w: z.number().finite().positive().max(1),
  h: z.number().finite().positive().max(1),
  confidence: z.number().finite().min(0).max(1),
  faceId: z.string().min(1).max(40)
}).strict().refine((p) => p.x + p.w <= 1.001 && p.y + p.h <= 1.001, "Face bounds leave the source frame.");
const faceTrackingSchema = z.object({
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
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function preferredFace(tracks) {
  return tracks.filter((t) => t.length).map((track) => ({
    id: track[0].faceId,
    score: track.reduce((sum, p) => sum + p.w * p.h * p.confidence * (1 - Math.min(0.8, Math.hypot(p.x + p.w / 2 - 0.5, p.y + p.h / 2 - 0.5))), 0) / track.length
  })).sort((a, b) => b.score - a.score)[0]?.id;
}
function smoothFaceTrack(settings, duration, manual = { x: 0.5, y: 0.5 }) {
  const input = settings.track.filter((p) => p.confidence >= 0.5 && p.t <= duration);
  if (!input.length) return [{ t: 0, ...manual }, { t: duration, ...manual }];
  const result = [], step = Math.max(0.1, duration / 599);
  let previous = input[0].t <= 0 && settings.startSeconds <= 0 ? { x: input[0].x + input[0].w / 2, y: input[0].y + input[0].h / 2 } : { ...manual }, index = 0;
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
    if (t < input[0].t || t < settings.startSeconds || t > settings.endSeconds) target = manual;
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
export {
  cameraAt,
  facePointSchema,
  faceTrackingSchema,
  preferredFace,
  smoothFaceTrack,
  trackedForegroundGeometry
};
