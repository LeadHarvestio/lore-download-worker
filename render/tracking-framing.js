import { smoothFaceTrack, trackedForegroundGeometry } from "./face-tracking-core.js";
import { sourceVideoFilter } from "./video-filters.js";
const even = n => Math.max(2, Math.round(n / 2) * 2);
/** Balanced expression tree: hundreds of keyframes do not exceed FFmpeg's
 * expression recursion limit. Pan remains inside the sharp layer's viewport.
 */
export function trackExpression(points, key, time = "t") {
  if (points.length < 2) return String(points[0]?.[key] ?? .5);
  function branch(lo, hi) {
    if (hi - lo === 1) {
      const a = points[lo], b = points[hi], dt = Math.max(.001, b.t - a.t);
      return `${a[key].toFixed(6)}+${(b[key] - a[key]).toFixed(6)}*min(max((${time}-${a.t.toFixed(4)})/${dt.toFixed(4)},0),1)`;
    }
    const mid = Math.floor((lo + hi) / 2);
    return `if(lt(${time},${points[mid].t.toFixed(4)}),${branch(lo, mid)},${branch(mid, hi)})`;
  }
  return branch(0, points.length - 1);
}
export function trackedLayoutFilter(layout, width, height, sw, sh, settings, look, at) {
  const tracking = settings.tracking;
  const geometry = trackedForegroundGeometry(sw, sh, width, height, layout, settings, tracking, { t: 0, x: .5, y: .5 });
  const { cropWidth: cw, cropHeight: ch, cropX, cropY, foregroundWidth: fw, foregroundHeight: fh } = geometry;
  const zoom = Math.max(settings.zoom, tracking.zoom), vh = layout === "fill" ? height : Math.min(height, fh / zoom);
  const duration = Math.max(tracking.endSeconds, ...tracking.track.map(p => p.t), .1);
  const camera = smoothFaceTrack(tracking, duration);
  const t = at === undefined ? "t" : String(at);
  const x = `min(max(${width / 2}-${fw}*((${sw}*(${trackExpression(camera, "x", t)})-${cropX})/${cw}),${Math.min(0, width - fw)}),${Math.max(0, (width - fw) / 2)})`;
  const y = `min(max(${height / 2}-${fh}*((${sh}*(${trackExpression(camera, "y", t)})-${cropY})/${ch}),${(height - vh) / 2 + vh - fh}),${(height - vh) / 2})`;
  const crop = `crop=${cw}:${ch}:${cropX}:${cropY},`;
  const filter = sourceVideoFilter(look);
  if (layout === "fill") return `[0:v]fps=30,${crop}${filter}scale=${fw}:${fh},crop=${width}:${height}:x='${width / 2}-(${x})-${width / 2}':y='-(${y})',setsar=1[base]`;
  return [
    `[0:v]fps=30,${crop}split=2[va][vb]`,
    `[va]scale=${even(width / 4)}:${even(height / 4)}:force_original_aspect_ratio=increase,crop=${even(width / 4)}:${even(height / 4)},boxblur=${Math.round(10 * width / 1080)}:6,eq=brightness=-0.12:saturation=1.1,scale=${width}:${height}[bg]`,
    `[vb]${filter}scale=${fw}:${fh},setsar=1[fg]`,
    `[bg][fg]overlay=x='${x}':y='${y}'[base]`,
  ].join(";");
}
