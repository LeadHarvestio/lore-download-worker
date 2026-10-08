// Keep source editing identical between style frames and finished MP4s.
export function sourceSettings(source = {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("source must be an object.");
  const result = { cropLeftPct: 0, cropRightPct: 0, cropTopPct: 0, cropBottomPct: 0, zoom: 1, muteAudio: false };
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(result, key)) throw new Error(`Unknown source setting: ${key}`);
    const value = source[key];
    if (key === "muteAudio") {
      if (typeof value !== "boolean") throw new Error("muteAudio must be a boolean.");
    } else if (typeof value !== "number" || !Number.isFinite(value) ||
      value < (key === "zoom" ? 1 : 0) || value > (key === "zoom" ? 3 : 40)) {
      throw new Error(`Invalid source setting: ${key}`);
    }
    result[key] = value;
  }
  return result;
}

const even = value => Math.max(2, Math.round(value / 2) * 2);
export function foregroundGeometry(sourceWidth, sourceHeight, width, height, source = {}) {
  const settings = sourceSettings(source);
  const croppedWidth = Math.max(2, Math.floor(sourceWidth * (1 - (settings.cropLeftPct + settings.cropRightPct) / 100) / 2) * 2);
  const croppedHeight = Math.max(2, Math.floor(sourceHeight * (1 - (settings.cropTopPct + settings.cropBottomPct) / 100) / 2) * 2);
  const scale = Math.min(width / croppedWidth, height / croppedHeight) * settings.zoom;
  return { croppedWidth, croppedHeight, width: even(croppedWidth * scale), height: even(croppedHeight * scale) };
}

export function layoutFilter(layout, width, height, sourceWidth, sourceHeight, source = {}) {
  if (layout === "fill") return `[0:v]fps=30,scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[base]`;
  const settings = sourceSettings(source);
  const geometry = foregroundGeometry(sourceWidth, sourceHeight, width, height, settings);
  const cropped = ["cropLeftPct", "cropRightPct", "cropTopPct", "cropBottomPct"].some(key => settings[key] !== 0);
  const crop = cropped ? `crop=w=${geometry.croppedWidth}:h=${geometry.croppedHeight}:x=${Math.floor(sourceWidth * settings.cropLeftPct / 100 / 2) * 2}:y=${Math.floor(sourceHeight * settings.cropTopPct / 100 / 2) * 2},` : "";
  return [
    `[0:v]fps=30,${crop}split=2[va][vb]`,
    `[va]scale=${even(width / 4)}:${even(height / 4)}:force_original_aspect_ratio=increase,crop=${even(width / 4)}:${even(height / 4)},boxblur=${Math.round(10 * width / 1080)}:6,eq=brightness=-0.12:saturation=1.1,scale=${width}:${height}[bg]`,
    `[vb]scale=${geometry.width}:${geometry.height},setsar=1[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`,
  ].join(";");
}
