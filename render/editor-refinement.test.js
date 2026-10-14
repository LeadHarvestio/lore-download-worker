import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { validateSourceEdit } from "./source-edit.js";
import { segmentFramingFilter } from "./segment-framing.js";
import { foregroundRect, prepareStackedCreative } from "./stacked-creative.js";

test("individual cut transforms survive validation and cannot alter adjacent cuts", () => {
  const edit = validateSourceEdit({ segments: [
    { srcStart: 0, srcEnd: 1, transform: { xPct: 25, yPct: 25, zoom: 1.1 } },
    { srcStart: 1, srcEnd: 2 },
  ] }, 2);
  assert.deepEqual(edit.segments[0].transform, { xPct: 25, yPct: 25, zoom: 1.1 });
  assert.equal(edit.segments[1].transform, undefined);
  assert.throws(() => validateSourceEdit({ segments: [{ srcStart: 0, srcEnd: 2, transform: { zoom: 999 } }] }, 2));
});
test("headline number glyphs have consistent cap height and normal advances", () => {
  assert.ok(GlobalFonts.registerFromPath(new URL("../fonts/BlockStamp-Regular.ttf", import.meta.url).pathname, "Headline Number QA"));
  const ctx = createCanvas(1800, 300).getContext("2d");
  ctx.font = '150px "Headline Number QA"';
  const h = ctx.measureText("H").actualBoundingBoxAscent;
  for (const digit of "0123456789") {
    const metrics = ctx.measureText(digit);
    assert.ok(Math.abs(metrics.actualBoundingBoxAscent - h) < 3, digit);
    assert.ok(metrics.width > 15 && metrics.width < 60, digit);
  }
});
test("decoded 1080p cut placements and below-video imagery agree at both cuts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "editor-stack-"));
  try {
    const source = path.join(dir, "source.mp4"), image = path.join(dir, "image.png");
    execFileSync("ffmpeg", ["-y","-loglevel","error","-f","lavfi","-i","color=c=red:s=160x90:r=30:d=2","-c:v","libx264","-threads","2",source]);
    const canvas = createCanvas(100,100), ctx = canvas.getContext("2d");
    ctx.fillStyle="#00ff00"; ctx.fillRect(0,0,100,100); fs.writeFileSync(image,canvas.toBuffer("image/png"));
    const edit = { segments:[{srcStart:0,srcEnd:1,transform:{yPct:25}},{srcStart:1,srcEnd:2,transform:{yPct:75}}] };
    const style = {layout:"blurfit",layers:[{id:"sample",assetId:"11111111-1111-4111-8111-111111111111",kind:"image",mode:"overlay",placement:"under-video",startSeconds:0,endSeconds:2,xPct:50,yPct:50,widthPct:40,heightPct:40,trimStartSeconds:0}],effects:[]};
    const args=["-y","-loglevel","error","-filter_complex_threads","1","-i",source];
    const creative=await prepareStackedCreative({style,args,nextIndex:1,width:1080,height:1920,duration:2,sourceWidth:160,sourceHeight:90,source:{},sourceEdit:edit,workDir:dir},async()=>image);
    const graph = [segmentFramingFilter("blurfit",1080,1920,160,90,{}, {},edit),...creative.filters].join(";");
    const script=path.join(dir,"filters.txt");fs.writeFileSync(script,graph);
    const output=path.join(dir,"output.mp4");
    execFileSync("ffmpeg",[...args,"-filter_complex_script",script,"-map",`[${creative.label}]`,"-t","2","-an","-c:v","libx264","-preset","ultrafast","-threads","2",output],{timeout:90000,maxBuffer:1000000});
    const pixel=(at,y)=>execFileSync("ffmpeg",["-loglevel","error","-ss",String(at),"-i",output,"-frames:v","1","-vf",`crop=2:2:540:${y},format=rgb24`,"-f","rawvideo","pipe:1"]);
    const red=(p)=>p[0]>200&&p[1]<30, green=(p)=>p[1]>200&&p[0]<30;
    assert.ok(red(pixel(.2,760)),"first cut must cover image at upper overlap");
    assert.ok(green(pixel(.2,1160)),"first cut must expose image below source");
    assert.ok(green(pixel(1.2,760)),"second cut must expose image above source");
    assert.ok(red(pixel(1.2,1160)),"second cut must cover image at lower overlap");
    assert.equal(foregroundRect({layout:"blurfit",width:1080,height:1920,sw:160,sh:90,source:{},edit},.2).y,176);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
