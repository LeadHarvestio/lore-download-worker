// Natural-font headline fitting. Never resize a pre-rendered text image.
export function renderHeadlineCoverFit({ text, highlight, width, height, style }, { createCanvas, FONTS, tokenize, measureWord, hexA }) {
  const cover = style.coverBox;
  if (!cover || !["xPct", "yPct", "widthPct", "heightPct"].every(k => Number.isFinite(cover[k])) ||
      cover.widthPct < 1 || cover.widthPct > 100 || cover.heightPct < 1 || cover.heightPct > 100 ||
      cover.xPct < cover.widthPct / 2 || cover.xPct > 100 - cover.widthPct / 2 ||
      cover.yPct < cover.heightPct / 2 || cover.yPct > 100 - cover.heightPct / 2) throw Error("Invalid headline cover bounds.");
  if (cover.bands && (!Array.isArray(cover.bands) || cover.bands.length > 80 || cover.bands.some(b =>
    !["x", "y", "width", "height"].every(k => Number.isFinite(b[k])) || b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0 ||
    b.x + b.width > 1.000001 || b.y + b.height > 1.000001))) throw Error("Invalid headline cover bands.");
  const canvas = createCanvas(width, height), ctx = canvas.getContext("2d");
  const rect = { x: width * (cover.xPct - cover.widthPct / 2) / 100, y: height * (cover.yPct - cover.heightPct / 2) / 100,
    width: width * cover.widthPct / 100, height: height * cover.heightPct / 100 };
  const family = FONTS[style.font]?.family || "Anton";
  const tokens = tokenize(text, highlight, Boolean(style.uppercase));
  const box = style.box || {}, stroke = style.stroke || {}, shadow = style.shadow || {}, glow = style.glow || {};
  const preferred = Math.max(8, width * (Number(style.sizePct) || 10) / 100);
  const inset = Math.max(2,
    stroke.enabled ? width * Number(stroke.widthPct || 0) / 100 * 2 : 0,
    shadow.enabled ? width * (Number(shadow.blurPct || 0) * 2.5 + Math.max(Math.abs(Number(shadow.offsetXPct || 0)), Math.abs(Number(shadow.offsetYPct || 0)))) / 100 : 0,
    glow.enabled ? width * Number(glow.blurPct || 0) * 2.5 / 100 : 0);
  const maxWidth = Math.max(1, rect.width - width * Number(box.padXPct || 0) / 100 * 2 - inset * 2);
  const maxHeight = Math.max(1, rect.height - width * Number(box.padYPct || 0) / 100 * 2 - inset * 2);
  const leading = Math.max(.8, Math.min(1.5, Number(style.lineHeight) || 1.08));
  const maxLines = Math.max(1, Math.min(4, Math.round(Number(style.maxLines) || 4)));
  const measure = (value, size) => {
    ctx.font = `${size}px "${family}", "Anton", sans-serif`;
    return measureWord(ctx, value, size, family);
  };
  const wrapAt = size => {
    const rows = [], widths = [], space = measure(" ", size).width * .9;
    let row = [], rowWidth = 0;
    for (const token of tokens) {
      const tw = measure(token.text, size).width, next = rowWidth + (row.length ? space : 0) + tw;
      if (row.length && next > maxWidth) { rows.push(row); widths.push(rowWidth); row = [token]; rowWidth = tw; }
      else { row.push(token); rowWidth = next; }
    }
    if (row.length) { rows.push(row); widths.push(rowWidth); }
    if (rows.length === 2 && widths[1] < widths[0] * .55) {
      let best = Math.abs(widths[0] - widths[1]);
      for (let split = 1; split < tokens.length; split++) {
        const a = tokens.slice(0, split), b = tokens.slice(split);
        const aw = a.reduce((s, t) => s + measure(t.text, size).width, 0) + space * (a.length - 1);
        const bw = b.reduce((s, t) => s + measure(t.text, size).width, 0) + space * (b.length - 1);
        if (aw <= maxWidth && bw <= maxWidth && Math.abs(aw - bw) < best) {
          best = Math.abs(aw - bw); rows.splice(0, 2, a, b); widths.splice(0, 2, aw, bw);
        }
      }
    }
    return { rows, widths, space };
  };
  const floor = Math.max(12, preferred * .68), maximum = Math.max(preferred, Math.min(maxWidth, preferred * 2.2));
  let size = floor, fitted = wrapAt(floor), expanded = true;
  for (let candidate = maximum; candidate >= floor; candidate -= .5) {
    const fit = wrapAt(candidate);
    if (fit.rows.length <= maxLines && Math.max(0, ...fit.widths) <= maxWidth &&
        fit.rows.reduce((sum, row) => {
          const m = row.map(t => measure(t.text, candidate));
          const ink = Math.max(0, ...m.map(x => x.actualBoundingBoxAscent)) + Math.max(0, ...m.map(x => x.actualBoundingBoxDescent));
          return sum + ink * Math.max(1, leading);
        }, 0) <= Math.max(maxHeight, candidate)) {
      size = candidate; fitted = fit; expanded = false; break;
    }
  }
  const metrics = fitted.rows.map(row => {
    const m = row.map(token => measure(token.text, size));
    return { ascent: Math.max(0, ...m.map(x => x.actualBoundingBoxAscent)), descent: Math.max(0, ...m.map(x => x.actualBoundingBoxDescent)) };
  });
  const advances = metrics.map(m => Math.max(m.ascent + m.descent, (m.ascent + m.descent) * leading));
  const totalHeight = advances.reduce((a, b) => a + b, 0);
  const top = rect.y + (rect.height - totalHeight) / 2;
  const padX = Math.max(0, width * Number(box.padXPct || 0) / 100), padY = Math.max(0, width * Number(box.padYPct || 0) / 100);
  const radius = Math.max(0, width * Number(box.radiusPct || 0) / 100);
  const rgb = /^#([0-9a-f]{6})$/i.exec(style.textColor)?.[1] || "FFFFFF";
  const luminance = parseInt(rgb.slice(0, 2), 16) * .299 + parseInt(rgb.slice(2, 4), 16) * .587 + parseInt(rgb.slice(4, 6), 16) * .114;
  ctx.fillStyle = box.enabled ? box.color || "#FFFFFF" : luminance > 150 ? "#101115" : "#FFFFFF";
  const roundRect = (x, y, w, h) => {
    const r = Math.min(radius, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fill();
  };
  // Opaque mask only where source text exists; selected line contours remain
  // visible outside that region rather than replacing the whole title by a box.
  if (cover.bands?.length) for (const b of cover.bands) roundRect(rect.x + b.x * rect.width, rect.y + b.y * rect.height, b.width * rect.width, b.height * rect.height);
  else roundRect(rect.x, rect.y, rect.width, rect.height);
  if (box.enabled && box.fitLines) {
    let y = top;
    fitted.rows.forEach((row, i) => {
      const w = fitted.widths[i] + padX * 2;
      roundRect(rect.x + rect.width / 2 - w / 2, y - padY, w, advances[i] + padY * 2);
      y += advances[i];
    });
  }
  const passes = [];
  if (glow.enabled) passes.push("glow");
  if (shadow.enabled) passes.push("shadow");
  if (stroke.enabled) passes.push("stroke");
  passes.push("fill");
  ctx.textBaseline = "alphabetic"; ctx.lineJoin = "round";
  for (const pass of passes) {
    let y = top;
    fitted.rows.forEach((row, i) => {
      let x = rect.x + (rect.width - fitted.widths[i]) / 2;
      const baseline = y + metrics[i].ascent;
      for (const token of row) {
        const m = measure(token.text, size), color = token.hl ? style.highlightColor || style.textColor : style.textColor;
        const paint = method => { let rx = x; for (const run of m.runs) { ctx.font = run.font; ctx[method](run.text, rx, baseline); rx += run.width; } };
        ctx.save(); ctx.fillStyle = color || "#FFFFFF";
        if (pass === "glow") {
          ctx.shadowColor = token.hl ? glow.color || "#FFFFFF" : hexA(glow.color || "#FFFFFF", 0);
          ctx.shadowBlur = width * Number(glow.blurPct || 0) / 100;
          for (let j = 0; j < Math.max(1, Math.min(8, Math.round(Number(glow.strength) || 1))); j++) paint("fillText");
        } else if (pass === "shadow") {
          ctx.shadowColor = hexA(shadow.color || "#000000", Number(shadow.opacity ?? .45));
          ctx.shadowBlur = width * Number(shadow.blurPct || 0) / 100;
          ctx.shadowOffsetX = width * Number(shadow.offsetXPct || 0) / 100;
          ctx.shadowOffsetY = width * Number(shadow.offsetYPct || 0) / 100; paint("fillText");
        } else if (pass === "stroke") {
          ctx.strokeStyle = stroke.color || "#000000"; ctx.lineWidth = width * Number(stroke.widthPct || 0) / 100 * 2; paint("strokeText");
        } else paint("fillText");
        ctx.restore(); x += m.width + fitted.space;
      }
      y += advances[i];
    });
  }
  return { buffer: canvas.toBuffer("image/png"), width, height, lines: fitted.rows.length, fontSize: size,
    visibleBox: rect, lineAdvance: Math.max(0, ...advances), inkHeight: Math.max(0, ...metrics.map(m => m.ascent + m.descent)),
    fitMetadata: { requestedSizePct: Number(style.sizePct), actualSizePct: size / width * 100, expanded },
    metadataHint: expanded ? "Headline expanded to retain readable text and all words." : null };
}
