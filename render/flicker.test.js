import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareCreativeInputs } from "./creative.js";
const run = promisify(execFile);
test("flicker native filters animate subtly, return to baseline and reject unsafe settings", async () => {
  const effect = {type:"flicker",startSeconds:0,endSeconds:2,speedHz:1,amount:.05,glow:.3};
  const build = (effects,previewAt) => prepareCreativeInputs({style:{effects},args:[],nextIndex:1,width:160,height:284,duration:2,previewAt});
  const result = await build([effect]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"flicker-test-")), file = path.join(dir,"clip.mp4");
  try {
    await run("ffmpeg",["-v","error","-y","-filter_complex_threads","1","-f","lavfi","-i","color=gray:s=160x284:r=30:d=2",
      "-filter_complex",["[0:v]format=gbrp[base]",...result.filters].join(";"),"-map",`[${result.label}]`,"-c:v","libx264","-preset","ultrafast","-crf","10","-threads","1",file],{timeout:20000});
    const pixel = async time => {
      const {stdout}=await run("ffmpeg",["-v","error","-ss",String(time),"-i",file,"-vf","crop=2:2:80:140,scale=1:1","-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","-threads","1","-"],{encoding:"buffer"});
      return stdout[0];
    };
    const start=await pixel(0), peak=await pixel(.5), reset=await pixel(1);
    assert.ok(peak>start+3 && peak<start+20,{start,peak,reset});
    assert.ok(Math.abs(reset-start)<3,{start,peak,reset});
    assert.ok((await build([effect],.5)).filters.join(";").includes("T+0.5"));
    for(const patch of [{speedHz:3},{amount:.5},{glow:2},{amount:NaN}]) await assert.rejects(build([{...effect,...patch}]),/Invalid subtle flicker/);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
