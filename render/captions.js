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

export function buildAss({ words, width, height, style }) {
  loadFonts();
  const S = style;
  const mctx = createCanvas(10, 10).getContext("2d");
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
  const chunks = buildChunks(words, S);
  chunks.forEach((chunk, ci) => {
    const nextChunkStart = chunks[ci + 1]?.[0]?.start ?? Infinity;
    chunk.forEach((w, wi) => {
      const start = wi === 0 ? chunk[0].start : w.start;
      let end = chunk[wi + 1] ? chunk[wi + 1].start : Math.min(w.end + 0.18, nextChunkStart);
      if (end <= 0) return; // seeking a preview must not revive earlier caption events
      if (end <= start) end = start + 0.12;

      const label = (s) => (S.uppercase ? s.toUpperCase() : s);
      const body = chunk.map((cw, k) =>
        `{\\1c${ass(k === wi ? S.highlightColor : S.textColor)}}${label(cw.word)}`
      ).join(" ");

      // shrink the whole chunk if it would exceed maxWidthPct of the frame
      const plainText = chunk.map((cw) => label(cw.word)).join(" ");
      mctx.font = `${fontSize}px "${family}"`;
      const natural = mctx.measureText(plainText).width;
      const limit = width * (S.maxWidthPct || 90) / 100;
      const fs = natural > limit ? Math.floor(fontSize * limit / natural) : fontSize;
      const pos = `\\an5\\pos(${x},${y})\\fs${fs}`;
      const pop = S.pop && wi === 0 ? `\\fscx82\\fscy82\\t(0,110,\\fscx100\\fscy100)` : "";

      if (S.glow?.enabled) {
        const gs = +(width * S.glow.sizePct / 100).toFixed(1);
        const gb = +(width * S.glow.blurPct / 100).toFixed(1);
        const plain = chunk.map((cw) => label(cw.word)).join(" ");
        events.push(`Dialogue: 0,${t(start)},${t(end)},Default,,0,0,0,,{${pos}${pop}\\bord${gs}\\blur${gb}\\shad0\\1a&HFF&\\3c${ass(S.glow.color)}\\3a&H40&}${plain}`);
      }
      events.push(`Dialogue: 1,${t(start)},${t(end)},Default,,0,0,0,,{${pos}${pop}\\blur${blur}}${body}`);
    });
  });

  return head.concat(events).join("\n") + "\n";
}
