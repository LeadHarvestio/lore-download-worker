import { renderHeadlinePng } from "./headline.js";
import { buildCaptionCues } from "./captions.js";
import { resolveStyle, FONTS } from "./styles.js";
import { censorWords, expletiveRanges } from "./censorship.js";

// An editing recipe: no media download, transcription or FFmpeg invocation.
export function livePreviewRecipe({ headline, highlightWords = [], words, stylePresetId, styleOverrides, censorCaptions = false }) {
  const style = resolveStyle(stylePresetId, styleOverrides);
  const width = 1080, height = 1920;
  const image = renderHeadlinePng({ text: headline, highlight: highlightWords, width, height, style: style.headline });
  const raw = (words || []).map(w => ({ ...w, word: w.word ?? w.text, start: w.start, end: w.end }));
  return {
    width, height,
    headline: { image: `data:image/png;base64,${image.buffer.toString("base64")}`, width: image.width, height: image.height, visibleBox: image.visibleBox },
    caption: { font: style.caption.font, family: FONTS[style.caption.font]?.family || "Archivo Black",
      cues: buildCaptionCues({ words: censorCaptions ? censorWords(raw) : raw, width, style: style.caption }) },
    muteRanges: expletiveRanges(raw, Math.max(0, ...raw.map(w => w.end)) + .06),
    transcriptAvailable: Array.isArray(words),
  };
}
