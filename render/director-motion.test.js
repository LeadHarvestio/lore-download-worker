import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { effectSchema, flashOpacity, zoomScale, validateDirectorStyle } from "./director-motion.js";
import { directorFramingFilter } from "./director-framing.js";
import { segmentFramingFilter } from "./segment-framing.js";
import { sourceSettings } from "./framing.js";
import { validateSourceEdit } from "./source-edit.js";
import { prepareCreativeInputs } from "./creative.js";
const zoom={type:"zoom",startSeconds:0,endSeconds:1,fromScale:1,toScale:1.12,easing:"easeOut",anchor:{x:.5,y:.35}};
const flash={type:"flash",color:"#19FF4A",opacity:.6,startSeconds:.2,endSeconds:.4,blend:"screen",envelope:{attack:1/6,hold:1/3,decay:1/2}};
const track=id=>({enabled:true,mode:"selectedFace",faceId:id,zoom:1.1,smoothness:.7,deadZonePct:4,startSeconds:0,endSeconds:2,
  track:Array.from({length:21},(_,i)=>({t:i/10,x:id==="left"?.2:.7,y:.17,w:.12,h:.23,confidence:.95,faceId:id}))});
test("strict additive schemas reject unknown controls and malformed native motion",()=>{
  for(const e of [{...zoom,toScale:5},{...flash,envelope:{attack:1,hold:1,decay:1}},{...zoom,anchor:{x:NaN,y:.5}},{...flash,type:"shake"}])
    assert.equal(effectSchema.safeParse(e).success,false);
  assert.throws(()=>validateDirectorStyle({sourcePanes:{topPct:99,top:{mode:"fill"},bottom:{mode:"blurfit"}}}));
  assert.throws(()=>validateSourceEdit({segments:[{srcStart:0,srcEnd:1,punchScale:3}]}));
  assert.equal(effectSchema.safeParse(zoom).success,true);
});
test("unchanged legacy framing is byte-identical; new fields are never defaulted",()=>{
  const source=sourceSettings(),style={layout:"blurfit",source};
  assert.equal(directorFramingFilter(style,108,192,320,180,source),segmentFramingFilter("blurfit",108,192,320,180,source));
  assert.equal(effectSchema.parse({type:"flash",startSeconds:0,endSeconds:1,color:"#00FF00",opacity:.25}).blend,undefined);
});
test("flash envelopes and zoom rise/end match the browser contract",()=>{
  assert.equal(flashOpacity(flash,.2),0);assert.ok(Math.abs(flashOpacity(flash,.25)-.6)<1e-9);
  assert.equal(flashOpacity(flash,.4),0);assert.equal(zoomScale(zoom,.25),1.12);assert.equal(zoomScale(zoom,1),1);
});
test("FFmpeg blends retain texture and obey the flash end boundary",async()=>{
  const filter=await prepareCreativeInputs({style:{effects:[flash]},args:[],nextIndex:1,width:64,height:64,duration:1});
  const graph=["[0:v]format=gbrp[base]",...filter.filters].join(";");
  const rgb=execFileSync("ffmpeg",["-v","error","-filter_complex_threads","1","-f","lavfi","-i","testsrc2=s=64x64:r=30:d=0.5",
    "-filter_complex",graph,"-map",`[${filter.label}]`,"-pix_fmt","rgb24","-f","rawvideo","-"]);
  const size=64*64*3;
  assert.ok(rgb.subarray(8*size,9*size).some(v=>v!==rgb[8*size]));
  assert.ok(rgb.length>=15*size);
  const baseline=execFileSync("ffmpeg",["-v","error","-filter_complex_threads","1","-f","lavfi","-i","testsrc2=s=64x64:r=30:d=0.5",
    "-vf","format=gbrp,format=rgb24","-pix_fmt","rgb24","-f","rawvideo","-"]);
  for(const frame of [0,6,7,8,9,10,11,12,14]){
    const alpha=flashOpacity(flash,frame/30),color=[25,255,74],index=frame*size+(32*64+32)*3;
    for(let c=0;c<3;c++){
      const base=baseline[index+c],screen=255-(255-base)*(255-color[c])/255;
      assert.ok(Math.abs(rgb[index+c]-(base*(1-alpha)+screen*alpha))<5,`decoded flash envelope frame ${frame}, channel ${c}`);
    }
  }
});
test("native fill/blurfit, independent panes, punches and selected tracks execute",()=>{
  for(const layout of ["fill","blurfit"]) for(const panes of [undefined,{topPct:58,top:{mode:"fill",tracking:track("left")},bottom:{mode:"fill",tracking:track("right")}}]){
    const style={layout,effects:[zoom],...(panes?{sourcePanes:panes}:{})};
    const edit={segments:[{srcStart:0,srcEnd:.5},{srcStart:.6,srcEnd:1.1,punchScale:1.1}]};
    const graph=directorFramingFilter(style,108,192,320,180,sourceSettings(),edit);
    execFileSync("ffmpeg",["-v","error","-filter_complex_threads","1","-f","lavfi","-i","testsrc2=s=320x180:r=30:d=1",
      "-filter_complex",graph,"-map","[base]","-t","1","-f","null","-"],{stdio:"pipe"});
  }
});
