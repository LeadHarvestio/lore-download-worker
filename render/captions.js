import { FONTS } from "./styles.js";
import { createCanvas } from "@napi-rs/canvas";
import { loadFonts } from "./headline.js";

// "#RRGGBB" -> "&HBBGGRR&" (ASS inline override colour)
function ass(hex) {
  const h = hex.replace("#", "");
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
}
function assStyleColor(hex, alpha = "00") {
  const h = hex.replace("#", "");
  return `&H${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}
function t(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}
const clean = (w) => w.replace(/[{}\\]/g, "").trim();

// words: [{ word, start, end }] in seconds (Whisper word timestamps)
export function buildChunks(words, S) {
  const chunks = [];
  let cur = [];
  const flush = () => { if (cur.length) { chunks.push(cur); cur = []; } };
  for (let i = 0; i < words.length; i++) {
    const w = { ...words[i], word: clean(words[i].word) };
    if (!w.word) continue;
    const prev = cur[cur.length - 1];
    const chars = cur.reduce((n, x) => n + x.word.length + 1, 0) + w.word.length;
    if (cur.length && (cur.length >= S.wordsPerChunk || chars > S.maxCharsPerChunk || w.start - prev.end > 0.6)) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.word)) flush();
  }
  flush();
  return chunks;
}

export function buildCaptionCues({ words, width, style }) {
  loadFonts();
  const family = FONTS[style.font]?.family || "Archivo Black";
  const fontSize = Math.round(width * style.sizePct / 100);
  const context = createCanvas(10, 10).getContext("2d");
  context.font = `${fontSize}px "${family}"`;
  const chunks = buildChunks(words, style);
  return chunks.flatMap((chunk, ci) => {
    const labels = chunk.map(w => style.uppercase ? w.word.toUpperCase() : w.word);
    const natural = style.stacked ? Math.max(...labels.map(label => context.measureText(label).width)) : context.measureText(labels.join(" ")).width;
    const limit = width * (style.maxWidthPct || 90) / 100;
    const size = natural > limit ? Math.floor(fontSize * limit / natural) : fontSize;
    return chunk.flatMap((word, wi) => {
      const start = word.start;
      let end = chunk[wi + 1]?.start ?? Math.min(word.end + .18, chunks[ci + 1]?.[0]?.start ?? Infinity);
      if (end <= 0) return [];
      if (end <= start) end = start + .12;
      return [{ start, end, fontSize: size, pop: !!style.pop && wi === 0,
        words: labels.map((text, k) => ({ text, active: k === wi, color: chunk[k].color,
          breakBefore: k > 0 && (!!style.stacked || !!chunk[k].breakBefore) })).filter((_word, k) => style.animation !== "reference" || k <= wi) }];
    });
  });
}

export function buildAss({ words, width, height, style }) {
  loadFonts();
  const S = style;
  const family = FONTS[S.font]?.family || "Archivo Black";
  const fontSize = Math.round(width * S.sizePct / 100);
  const outline = Math.max(0, +(width * S.outlinePct / 100).toFixed(1));
  const shadow = Math.max(0, +(width * S.shadowPct / 100).toFixed(1));
  const blur = Math.max(0, +(width * S.blurPct / 100).toFixed(2));
  const x = Math.round(width / 2), y = Math.round(height * S.yPct / 100);

  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${family},${fontSize},${assStyleColor(S.textColor)},${assStyleColor(S.textColor)},${assStyleColor(S.outlineColor)},${assStyleColor(S.shadowColor, "40")},0,0,0,0,100,100,0,0,1,${outline},${shadow},5,40,40,40,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events = [];
  buildCaptionCues({ words, width, style }).forEach((cue) => {
      const { start, end, fontSize: fs } = cue;
      const body = cue.words.map((cw, index) =>
        `${index ? cw.breakBefore ? "\\N" : " " : ""}{\\1c${ass(cw.color || (cw.active ? S.highlightColor : S.textColor))}}${cw.text}`
      ).join("");
      const pos = `\\an5\\pos(${x},${y})\\fs${fs}`;
      const ms = Math.min(300, Math.max(40, Number(S.animationMs) || 100));
      const exit = Math.max(ms, Math.round((end - start) * 1000) - ms);
      const pop = S.pop === false || S.animation === "none" ? "" : S.animation === "reference"
        ? `\\fscx128\\fscy72\\blur6\\t(0,${ms},\\fscx100\\fscy100\\blur${blur})\\t(${exit},${exit + ms},\\fscx138\\fscy70\\blur7\\alpha&HFF&)`
        : cue.pop ? `\\fscx82\\fscy82\\t(0,${ms},\\fscx100\\fscy100)` : "";

      if (S.glow?.enabled) {
        const gs = +(width * S.glow.sizePct / 100).toFixed(1);
        const gb = +(width * S.glow.blurPct / 100).toFixed(1);
        const plain = cue.words.map((cw, index) => `${index ? cw.breakBefore ? "\\N" : " " : ""}{\\3c${ass(cw.color || S.glow.color)}}${cw.text}`).join("");
        const glowPop = pop.replace(`\\blur${blur})`, `\\blur${gb})`);
        events.push(`Dialogue: 0,${t(start)},${t(end)},Default,,0,0,0,,{${pos}\\blur${gb}${glowPop}\\bord${gs}\\shad0\\1a&HFF&\\3a&H40&}${plain}`);
      }
      events.push(`Dialogue: 1,${t(start)},${t(end)},Default,,0,0,0,,{${pos}\\blur${blur}${pop}}${body}`);
  });

  return head.concat(events).join("\n") + "\n";
}
