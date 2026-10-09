import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import path from "path";
import { fileURLToPath } from "url";
import { FONTS } from "./styles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FONT_DIR = path.join(__dirname, "..", "fonts");

let fontsLoaded = false;
export function loadFonts() {
  if (fontsLoaded) return;
  for (const f of Object.values(FONTS)) {
    const ok = GlobalFonts.registerFromPath(path.join(FONT_DIR, f.file), f.family);
    if (!ok && f.family === "Block Stamp") throw new Error("Block Stamp font could not be registered. Check fonts/BlockStamp-Regular.ttf.");
    if (!ok) console.warn("[fonts] failed to register " + f.file);
  }
  fontsLoaded = true;
}

const norm = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");

// highlight: array of strings. A word is highlighted if it matches a single
// highlight word, or belongs to a multi-word highlight phrase ("REGGIE KISSING").
export function tokenize(text, highlight = [], uppercase = true) {
  const t = uppercase ? text.toUpperCase() : text;
  const words = t.split(/\s+/).filter(Boolean);
  const flags = new Array(words.length).fill(false);
  const normWords = words.map(norm);
  const positions = [...text.matchAll(/\S+/g)].map(match => ({ start: match.index, text: match[0] }));
  for (const h of highlight || []) {
    const positioned = /^@word:(\d+):(.*)$/.exec(String(h));
    if (positioned) {
      const index = Number(positioned[1]);
      if (positions[index]?.text.toLowerCase() === positioned[2].toLowerCase()) flags[index] = true;
      continue;
    }
    const hw = String(h).split(/\s+/).map(norm).filter(Boolean);
    if (!hw.length) continue;
    for (let i = 0; i + hw.length <= words.length; i++) {
      if (hw.every((x, j) => normWords[i + j] === x)) {
        for (let j = 0; j < hw.length; j++) flags[i + j] = true;
      }
    }
  }
  return words.map((w, i) => ({ text: w, hl: flags[i] }));
}

function wrap(ctx, tokens, maxTextW, spaceW) {
  const lines = [];
  let cur = [], curW = 0;
  for (const tk of tokens) {
    const w = ctx.measureText(tk.text).width;
    const add = cur.length ? spaceW + w : w;
    if (cur.length && curW + add > maxTextW) {
      lines.push({ tokens: cur, width: curW });
      cur = [tk]; curW = w;
    } else {
      cur.push(tk); curW += add;
    }
  }
  if (cur.length) lines.push({ tokens: cur, width: curW });
  return lines;
}

// Balance lines so the last line is not a single orphan word where possible.
function balance(ctx, tokens, lines, spaceW) {
  if (lines.length < 2) return lines;
  const n = lines.length;
  const total = lines.reduce((s, l) => s + l.width, 0);
  const target = total / n * 1.06;
  const out = []; let cur = [], curW = 0, idx = 0;
  for (const tk of tokens) {
    const w = ctx.measureText(tk.text).width;
    const add = cur.length ? spaceW + w : w;
    if (cur.length && curW + add > target && out.length < n - 1) {
      out.push({ tokens: cur, width: curW }); cur = [tk]; curW = w;
    } else { cur.push(tk); curW += add; }
  }
  if (cur.length) out.push({ tokens: cur, width: curW });
  const maxW = Math.max(...lines.map(l => l.width));
  return out.every(l => l.width <= maxW + 1) ? out : lines;
}

// Block Stamp omits punctuation/digits. Normalize fallback runs to its cap height;
// mixed-font measureText alone under-reports the taller fallback apostrophe.
function measureWord(ctx, text, size, family) {
  const primary = `${size}px "${family}", "Anton", sans-serif`;
  ctx.font = primary;
  const cap = ctx.measureText("H").actualBoundingBoxAscent;
  const parts = family === "Block Stamp" ? text.match(/[A-Za-z]+|[^A-Za-z]+/g) || [] : [text];
  const runs = parts.map(part => {
    let font = primary;
    if (family === "Block Stamp" && /[^A-Za-z]/.test(part)) {
      ctx.font = `${size}px "Anton", sans-serif`;
      const fallbackCap = ctx.measureText("H").actualBoundingBoxAscent;
      const glyph = ctx.measureText(part).actualBoundingBoxAscent;
      const scaled = size * cap / Math.max(fallbackCap, glyph, 1);
      font = `${scaled}px "Anton", sans-serif`;
    }
    ctx.font = font;
    const m = ctx.measureText(part);
    return { text: part, font, width: m.width, ascent: m.actualBoundingBoxAscent, descent: Math.max(0, m.actualBoundingBoxDescent) };
  });
  ctx.font = primary;
  return { width: runs.reduce((sum, r) => sum + r.width, 0),
    actualBoundingBoxAscent: Math.max(0, ...runs.map(r => r.ascent)),
    actualBoundingBoxDescent: Math.max(0, ...runs.map(r => r.descent)), runs };
}

export function renderHeadlinePng({ text, highlight, width, height, style }) {
  loadFonts();
  const S = style;
  const family = FONTS[S.font]?.family || "Anton";
  const box = S.box;
  const padX = box.enabled ? width * box.padXPct / 100 : 0;
  const padY = box.enabled ? width * box.padYPct / 100 : 0;
  const maxTextW = width * S.maxWidthPct / 100 - padX * 2;

  const probe = createCanvas(10, 10).getContext("2d");
  let size = width * S.sizePct / 100;
  const measuring = { measureText: text => measureWord(probe, text, size, family) };
  let lines, tokens = tokenize(text, highlight, S.uppercase), spaceW;
  for (let i = 0; i < 40; i++) {
    probe.font = `${size}px "${family}", "Anton", sans-serif`;
    spaceW = probe.measureText(" ").width * 0.9;
    lines = wrap(measuring, tokens, maxTextW, spaceW);
    const widest = Math.max(...lines.map(l => l.width));
    if (lines.length <= S.maxLines && widest <= maxTextW) break;
    size *= 0.94;
  }
  // Preserve natural reference-style wraps; rebalance only a single orphan word.
  if (lines.at(-1)?.tokens.length === 1 || lines.at(-1)?.width < Math.max(...lines.map(l => l.width)) * .55) {
    lines = balance(measuring, tokens, lines, spaceW);
  }

  const ink = lines.map(line => {
    const metrics = line.tokens.map(t => measuring.measureText(t.text));
    return { ascent: Math.max(...metrics.map(m => m.actualBoundingBoxAscent)), descent: Math.max(...metrics.map(m => m.actualBoundingBoxDescent)) };
  });
  const ascent = Math.max(...ink.map(m => m.ascent));
  const descent = Math.max(...ink.map(m => m.descent));
  const inkH = ascent + descent;
  const lineH = Math.max(inkH, inkH * S.lineHeight);
  const textW = Math.max(...lines.map(l => l.width));
  const textH = inkH + lineH * (lines.length - 1);
  const boxW = textW + padX * 2;
  const boxH = textH + padY * 2;

  // margin for glow / shadow bleed
  const margin = Math.ceil(width * 0.06);
  const cw = Math.ceil(boxW + margin * 2), ch = Math.ceil(boxH + margin * 2);
  const canvas = createCanvas(cw, ch);
  const ctx = canvas.getContext("2d");
  const bx = margin, by = margin;

  if (box.enabled) {
    ctx.save();
    ctx.globalAlpha = box.opacity;
    ctx.fillStyle = box.color;
    if (box.fitLines) {
      // Overlapping line-sized backgrounds form the tight stepped outline in the reference.
      ctx.beginPath();
      lines.forEach((line, li) => {
        roundRect(ctx, bx + (textW - line.width) / 2, by + li * lineH,
          line.width + padX * 2, inkH + padY * 2, width * box.radiusPct / 100, false);
      });
      ctx.fill();
    } else {
      roundRect(ctx, bx, by, boxW, boxH, width * box.radiusPct / 100);
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.font = `${size}px "${family}", "Anton", sans-serif`;
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";

  // Draw the text in layered passes: glow, shadow, stroke, fill.
  const passes = [];
  if (S.glow.enabled) passes.push("glow");
  if (S.shadow.enabled) passes.push("shadow");
  if (S.stroke.enabled) passes.push("stroke");
  passes.push("fill");

  for (const pass of passes) {
    lines.forEach((line, li) => {
      let x = bx + padX + (textW - line.width) / 2;
      const y = by + padY + li * lineH + ascent;
      line.tokens.forEach((tk, ti) => {
        const color = tk.hl ? S.highlightColor : S.textColor;
        const measured = measureWord(ctx, tk.text, size, family);
        const paint = mode => {
          let rx = x;
          for (const run of measured.runs) {
            ctx.font = run.font;
            ctx[mode](run.text, rx, y);
            rx += run.width;
          }
        };
        const w = measured.width;
        ctx.save();
        if (pass === "glow") {
          // highlighted words glow in the glow color; others get a softer white-ish halo only if glow.color set
          ctx.shadowColor = tk.hl ? S.glow.color : hexA(S.glow.color, 0.0);
          ctx.shadowBlur = width * S.glow.blurPct / 100;
          ctx.fillStyle = color;
          for (let k = 0; k < S.glow.strength; k++) paint("fillText");
        } else if (pass === "shadow") {
          ctx.shadowColor = hexA(S.shadow.color, S.shadow.opacity);
          ctx.shadowBlur = width * S.shadow.blurPct / 100;
          ctx.shadowOffsetX = width * S.shadow.offsetXPct / 100;
          ctx.shadowOffsetY = width * S.shadow.offsetYPct / 100;
          ctx.fillStyle = color;
          paint("fillText");
        } else if (pass === "stroke") {
          ctx.strokeStyle = S.stroke.color;
          ctx.lineWidth = width * S.stroke.widthPct / 100 * 2;
          paint("strokeText");
        } else {
          ctx.fillStyle = color;
          paint("fillText");
        }
        ctx.restore();
        x += w + spaceW;
      });
    });
  }

  return { buffer: canvas.toBuffer("image/png"), width: cw, height: ch, lines: lines.length, fontSize: size,
    visibleBox: { x: bx, y: by, width: boxW, height: boxH }, lineAdvance: lineH, inkHeight: inkH };
}

function roundRect(ctx, x, y, w, h, r, startPath = true) {
  r = Math.min(r, w / 2, h / 2);
  if (startPath) ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexA(hex, a) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
