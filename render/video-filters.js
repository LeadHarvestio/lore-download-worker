// Curated native looks, not proprietary CapCut presets. No-op by default.
export const VIDEO_FILTER_PRESETS = {
  none: [0, 1, 1, 0, 0], clean: [.01, 1.07, 1.04, .35, 0],
  vivid: [0, 1.1, 1.25, .25, 0], warm: [.01, 1.04, 1.08, 0, .06],
  cool: [0, 1.06, 1.03, 0, -.06], cinematic: [-.015, 1.16, .85, .15, .02],
  mono: [0, 1.1, 0, .2, 0],
};
export function videoFilterSettings(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("videoFilter must be an object.");
  const result = { preset: "none", strength: 1, brightness: 0, contrast: 1, saturation: 1, sharpness: 0 };
  const bounds = { strength: [0, 1], brightness: [-.2, .2], contrast: [.5, 1.5], saturation: [0, 2], sharpness: [0, 1] };
  for (const [key, val] of Object.entries(value)) {
    if (key === "preset") {
      if (typeof val !== "string" || !Object.hasOwn(VIDEO_FILTER_PRESETS, val)) throw new Error("Unknown video filter preset.");
    } else if (!bounds[key] || typeof val !== "number" || !Number.isFinite(val) || val < bounds[key][0] || val > bounds[key][1]) {
      throw new Error(`Invalid video filter setting: ${key}`);
    }
    result[key] = val;
  }
  return result;
}
export function sourceVideoFilter(value = {}) {
  const p = videoFilterSettings(value), [b, c, s, sharp, warm] = VIDEO_FILTER_PRESETS[p.preset], a = p.strength;
  const brightness = b * a + p.brightness, contrast = (1 + (c - 1) * a) * p.contrast;
  const saturation = (1 + (s - 1) * a) * p.saturation, sharpness = sharp * a + p.sharpness;
  const filters = [];
  if (brightness !== 0 || contrast !== 1 || saturation !== 1)
    filters.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`);
  if (warm * a) filters.push(`colorbalance=rs=${warm * a}:bs=${-warm * a}`);
  if (sharpness) filters.push(`unsharp=5:5:${sharpness}:5:5:0`);
  return filters.length ? filters.join(",") + "," : "";
}
