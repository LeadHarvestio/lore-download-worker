import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import path from "path";
import { fileURLToPath } from "url";
import { FONTS, PRESETS } from "./styles.js";

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
const PRESET_HEADLINE_MIN_SIZE_PCT = Math.min(...Object.values(PRESETS).map(preset => Number(preset.headline?.sizePct) || 100));

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

function renderHeadlineCover({ text, highlight, width, height, style, cover }) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const boxWidth = Math.max(1, Math.round(width * cover.widthPct / 100));
  const boxHeight = Math.max(1, Math.round(height * cover.heightPct / 100));
  const rect = {
    x: Math.max(0, Math.min(width - boxWidth, Math.round(width * cover.xPct / 100 - boxWidth / 2))),
    y: Math.max(0, Math.min(height - boxHeight, Math.round(height * cover.yPct / 100 - boxHeight / 2))),
    width: boxWidth,
    height: boxHeight,
  };
  const family = FONTS[style.font]?.family || "Anton";
  const box = style.box || {};
  const stroke = style.stroke || {};
  const shadow = style.shadow || {};
  const glow = style.glow || {};
  const boxPadX = box.enabled ? Math.min(rect.width * .3, width * Number(box.padXPct || 0) / 100) : 0;
  const boxPadY = box.enabled ? Math.min(rect.height * .3, width * Number(box.padYPct || 0) / 100) : 0;
  const strokeBleed = stroke.enabled ? width * Number(stroke.widthPct || 0) / 100 + 2 : 0;
  const shadowBleedX = shadow.enabled ? width * (Number(shadow.blurPct || 0) * 2.5 + Math.abs(Number(shadow.offsetXPct || 0))) / 100 : 0;
  const shadowBleedY = shadow.enabled ? width * (Number(shadow.blurPct || 0) * 2.5 + Math.abs(Number(shadow.offsetYPct || 0))) / 100 : 0;
  const glowBleed = glow.enabled ? width * Number(glow.blurPct || 0) * 2.5 / 100 : 0;
  const insetX = Math.max(width * .004, strokeBleed, shadowBleedX, glowBleed);
  const insetY = Math.max(width * .004, strokeBleed, shadowBleedY, glowBleed);
  const maxTextW = Math.max(1, Math.min(
    rect.width - boxPadX * 2 - insetX * 2,
    width * Math.max(.5, Math.min(100, Number(style.maxWidthPct) || 100)) / 100,
  ));
  const availableHeight = Math.max(1, rect.height - boxPadY * 2 - insetY * 2);
  const probe = createCanvas(10, 10).getContext("2d");
  const sizeStart = Math.max(1, width * Number(style.sizePct || 8) / 100);
  const maxLines = Math.max(1, Math.min(4, Math.round(Number(style.maxLines) || 4)));
  const tokens = tokenize(text, highlight, style.uppercase !== false);
  let size = sizeStart, lines = [], spaceW = 0;
  const measuring = { measureText: value => measureWord(probe, value, size, family) };
  for (let attempt = 0; attempt < 80; attempt++) {
    probe.font = `${size}px "${family}", "Anton", sans-serif`;
    spaceW = probe.measureText(" ").width * .9;
    lines = wrap(measuring, tokens, maxTextW, spaceW);
    const widest = Math.max(0, ...lines.map(line => line.width));
    const ink = lines.map(line => {
      const metrics = line.tokens.map(token => measuring.measureText(token.text));
      return {
        ascent: Math.max(0, ...metrics.map(metric => metric.actualBoundingBoxAscent)),
        descent: Math.max(0, ...metrics.map(metric => metric.actualBoundingBoxDescent)),
      };
    });
    const ascent = Math.max(0, ...ink.map(metric => metric.ascent));
    const descent = Math.max(0, ...ink.map(metric => metric.descent));
    const inkHeight = ascent + descent;
    const lineAdvance = Math.max(inkHeight, inkHeight * Math.max(.8, Math.min(1.5, Number(style.lineHeight) || 1.08)));
    const textHeight = inkHeight + lineAdvance * Math.max(0, lines.length - 1);
    if (lines.length <= maxLines && widest <= maxTextW && textHeight <= availableHeight) break;
    size *= .94;
  }
  if (lines.length > 1 && (lines.at(-1)?.tokens.length === 1 || (lines.at(-1)?.width || 0) < Math.max(...lines.map(line => line.width)) * .55)) {
    lines = balance(measuring, tokens, lines, spaceW);
  }
  const ink = lines.map(line => {
    const metrics = line.tokens.map(token => measuring.measureText(token.text));
    return {
      ascent: Math.max(0, ...metrics.map(metric => metric.actualBoundingBoxAscent)),
      descent: Math.max(0, ...metrics.map(metric => metric.actualBoundingBoxDescent)),
    };
  });
  const ascent = Math.max(0, ...ink.map(metric => metric.ascent));
  const descent = Math.max(0, ...ink.map(metric => metric.descent));
  const inkHeight = ascent + descent;
  const lineAdvance = Math.max(inkHeight, inkHeight * Math.max(.8, Math.min(1.5, Number(style.lineHeight) || 1.08)));
  const textHeight = inkHeight + lineAdvance * Math.max(0, lines.length - 1);
  const textWidth = Math.max(0, ...lines.map(line => line.width));
  const contentWidth = rect.width - boxPadX * 2 - insetX * 2;
  const contentHeight = rect.height - boxPadY * 2 - insetY * 2;

  if (box.enabled) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, Number(box.opacity ?? 1)));
    ctx.fillStyle = box.color || "#FFFFFF";
    roundRect(ctx, rect.x, rect.y, rect.width, rect.height, Math.min(width * Number(box.radiusPct || 0) / 100, rect.width / 2, rect.height / 2));
    ctx.fill();
    ctx.restore();
  }

  const drawPasses = [];
  if (glow.enabled) drawPasses.push("glow");
  if (shadow.enabled) drawPasses.push("shadow");
  if (stroke.enabled) drawPasses.push("stroke");
  drawPasses.push("fill");
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  for (const pass of drawPasses) {
    lines.forEach((line, lineIndex) => {
      let x = rect.x + boxPadX + insetX + (contentWidth - line.width) / 2;
      const baseline = rect.y + boxPadY + insetY + Math.max(0, (contentHeight - textHeight) / 2) + ascent + lineIndex * lineAdvance;
      for (const token of line.tokens) {
        const measured = measureWord(ctx, token.text, size, family);
        const color = token.hl ? style.highlightColor || style.textColor : style.textColor;
        const paint = mode => {
          let runX = x;
          for (const run of measured.runs) {
            ctx.font = run.font;
            ctx[mode](run.text, runX, baseline);
            runX += run.width;
          }
        };
        ctx.save();
        if (pass === "glow") {
          ctx.shadowColor = token.hl ? glow.color || "#FFFFFF" : hexA(glow.color || "#FFFFFF", 0);
          ctx.shadowBlur = width * Number(glow.blurPct || 0) / 100;
          ctx.fillStyle = color;
          for (let strength = 0; strength < Math.max(1, Math.min(8, Math.round(Number(glow.strength) || 1))); strength++) paint("fillText");
        } else if (pass === "shadow") {
          ctx.shadowColor = hexA(shadow.color || "#000000", Math.max(0, Math.min(1, Number(shadow.opacity ?? .45))));
          ctx.shadowBlur = width * Number(shadow.blurPct || 0) / 100;
          ctx.shadowOffsetX = width * Number(shadow.offsetXPct || 0) / 100;
          ctx.shadowOffsetY = width * Number(shadow.offsetYPct || 0) / 100;
          ctx.fillStyle = color;
          paint("fillText");
        } else if (pass === "stroke") {
          ctx.strokeStyle = stroke.color || "#000000";
          ctx.lineWidth = width * Number(stroke.widthPct || 0) / 100 * 2;
          paint("strokeText");
        } else {
          ctx.fillStyle = color || "#FFFFFF";
          paint("fillText");
        }
        ctx.restore();
        x += measured.width + spaceW;
      }
    });
  }
  ctx.restore();
  const actualSizePct = size / width * 100;
  const requestedSizePct = Number(style.sizePct) || 0;
  const outsidePresetLimits = actualSizePct < PRESET_HEADLINE_MIN_SIZE_PCT || Number(style.maxLines) > 4;
  return {
    buffer: canvas.toBuffer("image/png"), width, height, lines: lines.length, fontSize: size,
    visibleBox: rect, lineAdvance, inkHeight,
    fitMetadata: { requestedSizePct, actualSizePct, presetMinimumSizePct: PRESET_HEADLINE_MIN_SIZE_PCT, outsidePresetLimits },
    metadataHint: outsidePresetLimits ? "Cover fit required a size or line count outside built-in preset limits." : null,
  };
}

export function renderHeadlinePng({ text, highlight, width, height, style }) {
  loadFonts();
  if (style.coverBox) {
    const cover = style.coverBox;
    if (!["xPct", "yPct", "widthPct", "heightPct"].every(k => Number.isFinite(cover[k])) ||
      cover.widthPct < 1 || cover.widthPct > 100 || cover.heightPct < 1 || cover.heightPct > 100 ||
      cover.xPct < cover.widthPct / 2 || cover.xPct > 100 - cover.widthPct / 2 ||
      cover.yPct < cover.heightPct / 2 || cover.yPct > 100 - cover.heightPct / 2) throw Error("Invalid headline cover bounds.");
    return renderHeadlineCover({ text, highlight, width, height, style, cover });
  }
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

export function headlineCoverFixtureBoxes(width = 1080, height = 1920, count = 20, seed = 0x5192a7) {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return Array.from({ length: Math.max(1, Math.min(100, Math.floor(count))) }, () => {
    const widthPct = 8 + random() * 72;
    const heightPct = 6 + random() * 42;
    return {
      widthPct,
      heightPct,
      xPct: widthPct / 2 + random() * (100 - widthPct),
      yPct: heightPct / 2 + random() * (100 - heightPct),
    };
  });
}

export function renderHeadlineCoverFixtures({ text = "A PERSISTENT SOURCE HEADLINE", highlight = [], width = 1080, height = 1920, style, count = 20 }) {
  return headlineCoverFixtureBoxes(width, height, count).map((coverBox, index) => ({
    index,
    coverBox,
    ...renderHeadlinePng({ text, highlight, width, height, style: { ...style, coverBox } }),
  }));
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
