// Generated from app shared/face-tracking.ts; keep smoothing/validation in parity.
import { z } from "zod";
export const facePointSchema = z.object({
    t: z.number().finite().min(0).max(1800), x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
    w: z.number().finite().positive().max(1), h: z.number().finite().positive().max(1),
    confidence: z.number().finite().min(0).max(1), faceId: z.string().min(1).max(40),
}).strict().refine(p => p.x + p.w <= 1.001 && p.y + p.h <= 1.001, "Face bounds leave the source frame.");
export const faceTrackingSchema = z.object({
    enabled: z.boolean(), mode: z.enum(["autoFace", "selectedFace"]),
    zoom: z.number().finite().min(1).max(2.5), smoothness: z.number().finite().min(0).max(1),
    deadZonePct: z.number().finite().min(0).max(20), faceId: z.string().max(40).optional(),
    startSeconds: z.number().finite().min(0).max(1800), endSeconds: z.number().finite().positive().max(1800),
    track: z.array(facePointSchema).max(600),
}).strict().superRefine((value, ctx) => {
    if (value.endSeconds <= value.startSeconds)
        ctx.addIssue({ code: "custom", message: "Tracking end must follow its start." });
    value.track.forEach((p, i) => {
        if (i && p.t <= value.track[i - 1].t)
            ctx.addIssue({ code: "custom", message: "Tracking times must strictly increase." });
    });
});
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
export function preferredFace(tracks) {
    return tracks.filter(t => t.length).map(track => ({ id: track[0].faceId,
        score: track.reduce((sum, p) => sum + p.w * p.h * p.confidence * (1 - Math.min(.8, Math.hypot(p.x + p.w / 2 - .5, p.y + p.h / 2 - .5))), 0) / track.length,
    })).sort((a, b) => b.score - a.score)[0]?.id;
}
/** Dead-zone, bounded speed, short-loss hold, then ease back to manual framing.
 * This does not infer the active speaker or fabricate face detections.
 */
export function smoothFaceTrack(settings, duration, manual = { x: .5, y: .5 }) {
    const input = settings.track.filter(p => p.confidence >= .5 && p.t <= duration);
    if (!input.length)
        return [{ t: 0, ...manual }, { t: duration, ...manual }];
    const result = [], step = Math.max(.1, duration / 599);
    let previous = { x: input[0].x + input[0].w / 2, y: input[0].y + input[0].h / 2 }, index = 0;
    const alpha = Math.max(.035, 1 - settings.smoothness), dead = settings.deadZonePct / 100;
    for (let t = 0; t <= duration + .00001 && result.length < 600; t += step) {
        while (index + 1 < input.length && input[index + 1].t <= t)
            index++;
        const a = input[index], b = input[index + 1], age = t - a.t;
        let target = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
        if (b && b.t - a.t <= 1 && t >= a.t) {
            const f = clamp((t - a.t) / (b.t - a.t), 0, 1);
            target = { x: target.x + (b.x + b.w / 2 - target.x) * f, y: target.y + (b.y + b.h / 2 - target.y) * f };
        }
        else if (age > .8) {
            const f = clamp((age - .8) / .7, 0, 1);
            target = { x: target.x + (manual.x - target.x) * f, y: target.y + (manual.y - target.y) * f };
        }
        if (t < settings.startSeconds || t > settings.endSeconds)
            target = manual;
        const advance = (key) => {
            const delta = target[key] - previous[key];
            return Math.abs(delta) <= dead ? previous[key] : previous[key] + clamp(delta * alpha, -.45 * step, .45 * step);
        };
        previous = { x: advance("x"), y: advance("y") };
        result.push({ t: Math.min(duration, t), x: clamp(previous.x, 0, 1), y: clamp(previous.y, 0, 1) });
    }
    return result;
}
export function cameraAt(track, t) {
    if (!track.length)
        return { t, x: .5, y: .5 };
    const i = track.findIndex(p => p.t >= t);
    if (i <= 0)
        return { ...(i === -1 ? track.at(-1) : track[0]), t };
    const a = track[i - 1], b = track[i], f = clamp((t - a.t) / Math.max(.001, b.t - a.t), 0, 1);
    return { t, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}
