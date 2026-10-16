import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { loadFonts } from "./headline.js";
import { nameTagPosition } from "./director-geometry.js";

const escape = file => file.replaceAll("\\", "\\\\").replaceAll("'", "'\\''").replaceAll(":", "\\:");
// Text is rasterized, not interpolated into a filter expression or ASS markup.
export function prepareNameTags({ style, args, nextIndex, width, height, sw, sh, edit, duration, workDir, at, label }) {
  const filters = [];
  for (const [i, tag] of (style.nameTags || []).entries()) {
    loadFonts();
    const tw = Math.round(width * .3), th = Math.round(height * .075), pad = Math.ceil(width * .006);
    const canvas = createCanvas(tw + pad * 2, th + pad * 2), ctx = canvas.getContext("2d");
    ctx.translate(pad, pad);
    ctx.font = `900 ${Math.round(width * .045)}px "Archivo Black"`;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.lineWidth = width * .006; ctx.strokeStyle = "#000"; ctx.fillStyle = tag.color;
    ctx.strokeText(tag.text, tw / 2, 0, tw * .94); ctx.fillText(tag.text, tw / 2, 0, tw * .94);
    ctx.strokeStyle = tag.color; ctx.beginPath(); ctx.moveTo(tw * .5, th * .45); ctx.lineTo(tw * .5, th * .9);
    ctx.lineTo(tw * .4, th * .75); ctx.moveTo(tw * .5, th * .9); ctx.lineTo(tw * .6, th * .75); ctx.stroke();
    const png = path.join(workDir, `name-tag-${i}.png`);
    fs.writeFileSync(png, canvas.toBuffer("image/png"));
    args.push("-loop", "1", "-t", String(at === undefined ? duration : 1), "-i", png);
    const positionAt = time => {
      const p = nameTagPosition(tag, { ...style, sourceEdit: edit }, sw, sh, width, height, time);
      return p ? { x: Math.round(p.x - tw / 2 - pad), y: Math.round(p.y - pad) } : { x: -10000, y: -10000 };
    };
    const first = positionAt(at ?? 0), commands = [];
    if (at === undefined) {
      // Only a three-second interval (plus its hide frame) needs commands.
      const start = Math.max(1, Math.floor(tag.startSeconds * 30));
      const end = Math.min(Math.ceil(duration * 30) - 1, Math.ceil(tag.endSeconds * 30));
      for (let n = start; n <= end; n++) {
        const p = positionAt(n / 30);
        commands.push(`${(n / 30).toFixed(6)} overlay@nametag${i} x ${p.x}, overlay@nametag${i} y ${p.y};`);
      }
    }
    const commandFile = path.join(workDir, `name-tag-${i}-commands.txt`);
    fs.writeFileSync(commandFile, commands.join("\n"));
    filters.push(`[${label}]${commands.length ? `sendcmd=f='${escape(commandFile)}',` : ""}null[tagbase${i}]`,
      `[tagbase${i}][${nextIndex++}:v]overlay@nametag${i}=x=${first.x}:y=${first.y}:shortest=1[nameout${i}]`);
    label = `nameout${i}`;
  }
  return { filters, label, nextIndex };
}
