import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { affineTransformSchema, validateAffineUsage } from "./affine-transform.js";
import { validateSourceEdit } from "./source-edit.js";
import { layoutFilter } from "./framing.js";
import { resolveStyle, FONTS } from "./styles.js";
const run = promisify(execFile);
const cwd = fileURLToPath(new URL("..", import.meta.url));
const affine = { version: 1, rotationDeg: 33, scaleX: .56, scaleY: .72 };
test("strict affine schema, legacy framing and unsupported combinations", () => {
  assert.throws(() => affineTransformSchema.parse({ version: 2 }));
  assert.throws(() => affineTransformSchema.parse({ version: 1, scaleY: 0 }));
  assert.throws(() => affineTransformSchema.parse({ version: 1, rotationDeg: 181 }));
  assert.throws(() => validateAffineUsage({ source: { affine, tracking: { enabled: true } } }));
  assert.throws(() => validateAffineUsage({ layers: [{ mode: "split-top", affine }] }));
  assert.deepEqual(validateSourceEdit({ segments: [{ srcStart: 0, srcEnd: 1, transform: { affine } }] }).segments[0].transform.affine, affine);
  assert.equal(layoutFilter("fill", 1080, 1920, 360, 200), "[0:v]fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[base]");
});

function pixels(bytes) {
  return loadImage(bytes).then(img => {
    const c = createCanvas(img.width, img.height), ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0); return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
  });
}
function colored(p, kind) {
  let count = 0, x = 0, y = 0;
  for (let row = 0; row < p.height; row += 3) for (let col = 0; col < p.width; col += 3) {
    const i = (row*p.width+col)*4, [r,g,b] = p.data.slice(i,i+3);
    const match = kind === "red" ? r > 185 && g < 75 && b < 75 : g > 180 && r < 85 && b < 85;
    if (match) { count++; x += col; y += row; }
  }
  return { count, x: x/count, y: y/count };
}
test("authenticated queue: affine PNG and decoded 1080p/30fps MP4 preserve source, overlays, words and audio", { timeout: 240000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "affine-http-"));
  const artifacts = process.env.AFFINE_TEST_ARTIFACT_DIR;
  if (artifacts) await fs.mkdir(artifacts, { recursive: true });
  const cached = [];
  const key = "local-affine-fixture-only";
  const child = spawn(process.execPath, ["server.js"], { cwd,
    env: { ...process.env, API_KEY: key, PORT: "0", DOWNLOAD_DIR: dir, ENABLE_FACE_TRACKING: "0", RENDER_CACHE_DIR: path.join(dir, "cache") },
    stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  try {
    const root = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(logs || "Worker startup timed out")), 15000);
      const data = chunk => { logs += chunk; const match = logs.match(/(?:running|listening) on port (\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } };
      child.stdout.on("data", data); child.stderr.on("data", data);
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Worker exited ${code}: ${logs}`)); });
    });
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    const post = (url, body, auth = true) => fetch(root+url, { method: "POST", headers: auth ? headers : { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await run("ffmpeg", ["-y","-loglevel","error","-f","lavfi","-i",
      "color=c=blue:s=360x200:r=30:d=1.2,drawbox=x=20:y=30:w=100:h=80:c=red:t=fill",
      "-f","lavfi","-i","sine=frequency=600:duration=1.2","-threads","1","-c:v","libx264","-preset","ultrafast","-c:a","aac","-shortest",path.join(dir,"source.mp4")]);
    if (artifacts) await fs.copyFile(path.join(dir,"source.mp4"), path.join(artifacts,"source.mp4"));
    const catalog = await (await fetch(root+"/api/styles", { headers })).json();
    assert.equal(catalog.capabilities.affineTransforms, 1);
    assert.deepEqual([catalog.output.width,catalog.output.height,catalog.output.fps], [1080,1920,30]);
    const words = [{ word: "keep", start: .1, end: .6 }];
    const common = { clipFilename:"source.mp4", headline:"KEEP TYPE", words, highlightWords:[] };
    assert.equal((await post("/api/process", {...common,jobId:"unauthorized"},false)).status,401);
    assert.equal((await post("/api/preview",common,false)).status,401);
    assert.equal((await post("/api/live-preview",common,false)).status,401);
    const recipe = await (await post("/api/live-preview",{...common,styleOverrides:{source:{affine}}})).json();
    assert.equal(recipe.affineTransforms,1); assert.ok(recipe.headline.image.startsWith("data:image/png;base64,"));
    assert.equal((await post("/api/preview",{...common,styleOverrides:{source:{affine:{version:2}}}})).status,400);
    const png = createCanvas(160,100), ctx = png.getContext("2d");
    ctx.fillStyle="#00ff00"; ctx.fillRect(0,0,160,100);
    const imageBytes = png.toBuffer("image/png");
    const imagePath=path.join(dir,"image.png"); await fs.writeFile(imagePath,imageBytes);
    await run("ffmpeg",["-y","-loglevel","error","-loop","1","-i",imagePath,"-t","1.2","-c:v","libx264","-threads","1","-pix_fmt","yuv420p",path.join(dir,"context.mp4")]);
    const layers=[];
    for(const [i,kind] of ["image","cutout","video"].entries()) {
      const id=`12345678-1234-4234-8234-12345678900${i}`;
      const assetUrl=`https://affine-fixture.replit.app/api/editing-assets/${id}/file`;
      const file=path.join(cwd,"uploads/context-assets",createHash("sha256").update(assetUrl).digest("hex")+(kind==="video"?".mp4":".png"));
      await fs.mkdir(path.dirname(file),{recursive:true});
      await fs.copyFile(kind==="video"?path.join(dir,"context.mp4"):imagePath,file); cached.push(file);
      layers.push({id,assetId:id,assetUrl,kind,mode:"overlay",xPct:70,yPct:72,widthPct:20,heightPct:15,
        startSeconds:0,endSeconds:1.1,enterAnimation:"none",glow:{enabled:false},affine:{version:1,rotationDeg:-25,scaleX:.7,scaleY:1.4}});
    }
    const cases = [
      { layout:"blurfit",source:{affine,xPct:45,yPct:45,cropLeftPct:4,zoom:1.1} },
      { layout:"fill",source:{affine:{...affine,scaleX:.24,scaleY:.22},xPct:45,yPct:45,cropLeftPct:4,zoom:1.1} },
      ...layers.map(layer=>({layout:"blurfit",source:{affine,xPct:45,yPct:45},layers:[layer]})),
      { layout:"blurfit",source:{xPct:45,yPct:45},layers:[{...layers[0],placement:"under-video",xPct:50,yPct:40,widthPct:70,heightPct:40}] },
    ];
    for (const [index, settings] of cases.entries()) {
      const sourceEdit = index === 5 ? {segments:[{srcStart:0,srcEnd:1.1,transform:{affine}}]} : undefined;
      const body = {...common,jobId:`affine_${index}`,styleOverrides:settings,...(sourceEdit?{sourceEdit}:{})};
      const queued=await post("/api/process",body); assert.equal(queued.status,202,await queued.text());
      let job;
      for(let attempts=0;attempts<600;attempts++) {
        job=await (await fetch(root+`/api/process/status/affine_${index}`,{headers})).json();
        if(["completed","failed"].includes(job.status))break;
        await new Promise(resolve=>setTimeout(resolve,150));
      }
      assert.equal(job.status,"completed",JSON.stringify(job)+logs);
      assert.equal(job.words[0].word,"keep","cached words preserved");
      const response=await post("/api/preview",{...body,at:.4});
      assert.equal(response.status,200,response.ok?"":await response.text());
      const preview=Buffer.from(await response.arrayBuffer());
      const file=path.join(dir,job.filename);
      const {stdout:decoded}=await run("ffmpeg",["-v","error","-ss","0.4","-i",file,"-frames:v","1","-f","image2pipe","-c:v","png","-threads","1","-"],{encoding:"buffer",maxBuffer:12000000});
      const a=await pixels(preview),b=await pixels(decoded);
      if (artifacts) {
        await fs.writeFile(path.join(artifacts,`preview-${index}.png`),preview);
        await fs.writeFile(path.join(artifacts,`export-${index}.png`),decoded);
        await fs.copyFile(file,path.join(artifacts,`export-${index}.mp4`));
        const recipeResponse=await post("/api/live-preview",body);
        const resolvedStyle=resolveStyle(body.stylePresetId,body.styleOverrides);
        const recipe=await recipeResponse.json();
        await fs.writeFile(path.join(artifacts,`case-${index}.json`),JSON.stringify({body,recipe,resolvedStyle}));
        await fs.copyFile(path.join(cwd,"fonts",FONTS[recipe.caption.font].file),path.join(artifacts,"caption-font.otf"));
        await fs.writeFile(path.join(artifacts,"context.png"),imageBytes);
        await fs.copyFile(path.join(dir,"context.mp4"),path.join(artifacts,"context.mp4"));
      }
      assert.deepEqual([a.width,a.height,b.width,b.height],[1080,1920,1080,1920]);
      for(const color of settings.layers?.length?["red","green"]:["red"]) {
        const ac=colored(a,color),bc=colored(b,color);
        assert.ok(ac.count>150 && bc.count>150,`${index} ${color} visible ${JSON.stringify({ac,bc})}`);
        assert.ok(Math.abs(ac.x-bc.x)<6 && Math.abs(ac.y-bc.y)<6,`${index} ${color} centroid parity`);
        assert.ok(Math.abs(ac.count-bc.count)/Math.max(ac.count,bc.count)<.09,`${index} ${color} area parity`);
      }
      const {stdout:probe}=await run("ffprobe",["-v","error","-show_streams","-of","json",file]);
      const streams=JSON.parse(probe).streams;
      assert.equal(streams.find(s=>s.codec_type==="video").r_frame_rate,"30/1");
      assert.ok(streams.find(s=>s.codec_type==="audio"),"original audio retained");
    }
  } finally {
    child.kill("SIGTERM");
    await Promise.all(cached.map(file=>fs.rm(file,{force:true})));
    await fs.rm(dir,{recursive:true,force:true});
  }
});
