import fs from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { nameTagPosition } from "./director-geometry.js";
import { trackExpression } from "./tracking-framing.js";
export async function prepareNameTags({ style, args, nextIndex, width, height, sw, sh, duration, at, workDir, input }) {
  const filters = []; let current = input, index = nextIndex;
  for (const [n,tag] of (style.nameTags || []).entries()) {
    const tw = Math.round(width*.3), th = Math.round(height*.075), image = createCanvas(tw,th), ctx = image.getContext("2d");
    ctx.font = `900 ${Math.round(width*.045)}px "Archivo Black"`;
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.lineWidth = width*.006;
    ctx.strokeStyle = "#000000"; ctx.fillStyle = tag.color;
    ctx.strokeText(tag.text,tw/2,0,tw*.94); ctx.fillText(tag.text,tw/2,0,tw*.94);
    ctx.strokeStyle = tag.color; ctx.lineWidth = width*.006;
    ctx.beginPath(); ctx.moveTo(tw*.5,th*.45); ctx.lineTo(tw*.5,th*.9);
    ctx.lineTo(tw*.4,th*.75); ctx.moveTo(tw*.5,th*.9); ctx.lineTo(tw*.6,th*.75); ctx.stroke();
    const file = path.join(workDir,`name-tag-${n}.png`); await fs.writeFile(file,image.toBuffer("image/png"));
    args.push("-loop","1","-t",String(at===undefined?duration:1),"-i",file);
    const positions = [];
    const first = at ?? 0, end = at === undefined ? duration : at;
    for (let t=first; t<=end+.0001; t+=1/30) {
      const p = nameTagPosition(tag,style,sw,sh,width,height,t);
      positions.push({t: t-(at??0), x:p?p.x-tw/2:-width*2, y:p?p.y:-height*2});
    }
    const output = `tagged${n}`, x = trackExpression(positions,"x"), y = trackExpression(positions,"y");
    filters.push(`[${current}][${index++}:v]overlay=x='${x}':y='${y}':eval=frame:shortest=1[${output}]`);
    current = output;
  }
  return {filters,label:current,nextIndex:index};
}
