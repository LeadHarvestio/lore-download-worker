// Style presets. Every visual knob lives here so Replit can store/edit them as JSON.
// Percentages are relative to frame width (sizePct, padPct, radiusPct) or frame height (yPct).
// Colors are CSS hex strings.

export const FONTS = {
  // key -> { family (as registered / as libass sees it), file }
  "Anton":        { family: "Anton",        file: "Anton-Regular.ttf" },
  "Archivo Black":{ family: "Archivo Black",file: "ArchivoBlack-Regular.ttf" },
  "Bebas Neue":   { family: "Bebas Neue",   file: "BebasNeue-Regular.ttf" },
  "Block Stamp":  { family: "Block Stamp",  file: "BlockStamp-Regular.ttf" },
};

const baseHeadline = {
  font: "Block Stamp",
  sizePct: 8.2,          // font size as % of frame width
  uppercase: true,
  lineHeight: 1.08,
  maxWidthPct: 86,       // max text block width (incl. box padding) as % of frame width
  maxLines: 4,
  textColor: "#000000",
  highlightColor: "#E11010",
  yPct: 24,              // vertical CENTER of the headline block, % of frame height
  box: { enabled: true, color: "#FFFFFF", opacity: 1, radiusPct: 3.2, padXPct: 4.2, padYPct: 2.2 },
  stroke: { enabled: false, color: "#000000", widthPct: 0.5 },
  shadow: { enabled: false, color: "#000000", opacity: 0.45, blurPct: 1.2, offsetXPct: 0, offsetYPct: 0.5 },
  glow:   { enabled: false, color: "#FFFFFF", blurPct: 2.5, strength: 2 },
  seconds: null,         // null = show for the whole clip, otherwise first N seconds
};

const baseCaption = {
  font: "Archivo Black",
  sizePct: 11.5,         // font size as % of frame WIDTH (auto-shrinks per chunk to fit maxWidthPct)
  maxWidthPct: 90,
  uppercase: true,
  textColor: "#FFFFFF",
  highlightColor: "#19E3F2",
  outlineColor: "#000000",
  outlinePct: 0.45,      // % of frame width
  shadowColor: "#000000",
  shadowPct: 0.5,
  blurPct: 0.12,
  glow: { enabled: false, color: "#19E3F2", sizePct: 1.2, blurPct: 1.4 },
  yPct: 72,              // vertical center of the caption, % of frame height
  wordsPerChunk: 2,      // 1-3. Words shown together
  maxCharsPerChunk: 16,
  pop: true,             // quick scale-in on every chunk
};

export const PRESETS = {
  // Reference 2 / 4: white rounded box, condensed black text, red key words
  boxed_red: {
    id: "boxed_red",
    name: "Boxed Red",
    layout: "blurfit",
    headline: { ...baseHeadline, sizePct: 7.6, maxLines: 3, yPct: 60 },
    caption: { ...baseCaption, highlightColor: "#FFE600", yPct: 80 },
  },
  // Reference 3: no box, wide heavy font, white + magenta, glow
  glow_magenta: {
    id: "glow_magenta",
    name: "Glow Magenta",
    layout: "blurfit",
    headline: {
      ...baseHeadline,
      font: "Block Stamp",
      sizePct: 17,
      lineHeight: 1.0,
      maxLines: 3,
      maxWidthPct: 90,
      textColor: "#FFFFFF",
      highlightColor: "#F21DE0",
      yPct: 19,
      box: { ...baseHeadline.box, enabled: false },
      stroke: { enabled: true, color: "#1A001A", widthPct: 0.28 },
      shadow: { enabled: true, color: "#000000", opacity: 0.5, blurPct: 1.2, offsetXPct: 0, offsetYPct: 0.6 },
      glow: { enabled: true, color: "#F21DE0", blurPct: 1.7, strength: 1 },
    },
    caption: { ...baseCaption, highlightColor: "#F21DE0", glow: { enabled: true, color: "#F21DE0", sizePct: 0.9, blurPct: 1.2 } },
  },
  // Reference 4 captions: cyan active word, shadow, no glow. Headline = same boxed look.
  cyan_pop: {
    id: "cyan_pop",
    name: "Cyan Pop",
    layout: "blurfit",
    headline: { ...baseHeadline, sizePct: 7.4, maxLines: 3, yPct: 17 },
    caption: { ...baseCaption, highlightColor: "#19E3F2", wordsPerChunk: 2, yPct: 70 },
  },
};

// Deep-merge user overrides (from the DB / UI) over a preset.
export function resolveStyle(presetId, overrides = {}) {
  const base = PRESETS[presetId] || PRESETS.boxed_red;
  return deepMerge(structuredClone(base), overrides || {});
}

function deepMerge(target, src) {
  for (const k of Object.keys(src)) {
    if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k]) && target[k] && typeof target[k] === "object") {
      deepMerge(target[k], src[k]);
    } else if (src[k] !== undefined) {
      target[k] = src[k];
    }
  }
  return target;
}
