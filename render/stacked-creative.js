import fs from "node:fs";
import path from "node:path";
import { prepareCreativeInputs } from "./creative.js";
import { foregroundGeometry, sourceSettings } from "./framing.js";
import { smoothFaceTrack, cameraAt, trackedForegroundGeometry } from "./face-tracking-core.js";
import { directorForegroundGeometry } from "./director-geometry.js";

function directorRects(options,at) {
  const {width,height,sourceWidth:sw,sourceHeight:sh,style}=options;
  let segment, cursor=0;
  for(const s of options.sourceEdit?.segments || []){
    cursor+=(s.srcEnd-s.srcStart)/(s.speed??1);if(at<cursor){segment=s;break;}
  }
  const panes=style.sourcePanes, topH=panes?Math.round(height*panes.topPct/100/2)*2:height;
  return (panes?[["top",0,topH],["bottom",topH,height-topH]]:[[null,0,height]]).map(([key,py,ph])=>{
    const {tracking:_ignored,...manual}=options.source;
    let source=key?{...manual,...(panes[key].tracking?{tracking:panes[key].tracking}:{})}:options.source;
    if(segment?.transform)source={...source,...segment.transform,...(source.tracking?{tracking:{...source.tracking,enabled:false}}:{})};
    if(segment?.punchScale)source={...source,zoom:Math.min(3,Math.max(source.zoom??1,source.tracking?.enabled?source.tracking.zoom:1)*segment.punchScale)};
    const g=directorForegroundGeometry(sw,sh,width,ph,key?panes[key].mode:style.layout,source,style.effects||[],at);
    const x=Math.max(0,Math.min(width-1,Math.round(g.foregroundX))),y=Math.max(0,Math.min(ph-1,Math.round(g.foregroundY)));
    return {x,y:y+py,w:Math.max(1,Math.min(width,Math.round(g.foregroundX+g.foregroundWidth))-x),
      h:Math.max(1,Math.min(ph,Math.round(g.foregroundY+g.foregroundHeight))-y)};
  });
}

export function foregroundRect({ layout, width, height, sw, sh, source, edit, preparedSource, cameraPoints }, at) {
  let settings = preparedSource || sourceSettings(source), cursor = 0;
  for (const segment of edit?.segments || []) {
    cursor += (segment.srcEnd - segment.srcStart) / (segment.speed ?? 1);
    if (at < cursor) {
      if (segment.transform) settings = { ...settings, ...segment.transform,
        ...(settings.tracking ? { tracking: { ...settings.tracking, enabled: false } } : {}) };
      break;
    }
  }
  let x, y, w, h;
  if (settings.tracking?.enabled) {
    const tracking = settings.tracking;
    const points = cameraPoints || smoothFaceTrack(tracking, Math.max(tracking.endSeconds, ...tracking.track.map(point => point.t), .1));
    const geometry = trackedForegroundGeometry(sw, sh, width, height, layout, settings, tracking, cameraAt(points, at));
    ({ foregroundX: x, foregroundY: y, foregroundWidth: w, foregroundHeight: h } = geometry);
  } else {
    const geometry = foregroundGeometry(sw, sh, width, height, settings, layout);
    if (layout === "fill" && settings.zoom === 1 && !settings.cropLeftPct && !settings.cropRightPct && !settings.cropTopPct && !settings.cropBottomPct) {
      const ratio = Math.max(width / sw, height / sh);
      w = Math.round(sw * ratio / 2) * 2; h = Math.round(sh * ratio / 2) * 2;
    } else { w = geometry.width; h = geometry.height; }
    x = width * settings.xPct / 100 - w / 2;
    y = height * settings.yPct / 100 - h / 2;
  }
  const left = Math.max(0, Math.round(x)), top = Math.max(0, Math.round(y));
  return { x: left, y: top, w: Math.max(1, Math.min(width, Math.round(x + w)) - left),
    h: Math.max(1, Math.min(height, Math.round(y + h)) - top) };
}

// Restore only the sharp source pixels over the lower context plane. The
// background remains visible behind context, and captions/headlines stay above.
// Compute rectangle commands once per frame, not inside a per-pixel expression.
export async function prepareStackedCreative(options, resolver) {
  const below = (options.style.layers || []).filter(layer => layer.placement === "under-video");
  if (!below.length) return prepareCreativeInputs(options, resolver);
  if (below.some(layer => layer.mode !== "overlay")) throw new Error("Split layouts must stay above the source video.");
  const under = await prepareCreativeInputs({ ...options, style: { ...options.style, layers: below, effects: [] }, initialLabel: "lowerbase" }, resolver);
  const rename = text => text.replace(/\[([A-Za-z][\w]*)\]/g, (match, label) => label === "lowerbase" ? match : `[lower_${label}]`);
  const above = await prepareCreativeInputs({ ...options, nextIndex: under.nextIndex,
    style: { ...options.style, layers: (options.style.layers || []).filter(layer => layer.placement !== "under-video") },
    initialLabel: "upperbase",
  }, resolver);
  const underLabel = under.label === "lowerbase" ? under.label : `lower_${under.label}`;
  const geometry = { layout: options.style.layout, width: options.width, height: options.height,
    sw: options.sourceWidth, sh: options.sourceHeight, source: options.source, edit: options.sourceEdit,
    preparedSource: sourceSettings(options.source),
    cameraPoints: options.source?.tracking?.enabled ? smoothFaceTrack(options.source.tracking, Math.max(options.source.tracking.endSeconds, ...options.source.tracking.track.map(point => point.t), .1)) : undefined };
  const hasDirector = options.style.sourcePanes || options.style.effects?.some(e=>e.type==="zoom") || options.sourceEdit?.segments.some(s=>s.punchScale);
  const rects = at => hasDirector ? directorRects(options,at) : [foregroundRect(geometry,at)];
  const first = rects(options.previewAt ?? 0);
  const commands = [];
  if (options.previewAt === undefined) {
    for (let frame = 1; frame < Math.ceil(options.duration * 30); frame++) {
      const at = frame / 30;
      rects(at).forEach((rect,i)=>commands.push(`${at.toFixed(6)} drawbox@sourceplane${i} x ${rect.x}, drawbox@sourceplane${i} y ${rect.y}, drawbox@sourceplane${i} w ${rect.w}, drawbox@sourceplane${i} h ${rect.h};`));
    }
  }
  const commandFile = path.join(options.workDir, "source-plane-commands.txt");
  fs.writeFileSync(commandFile, commands.join("\n"));
  const escaped = commandFile.replaceAll("\\", "\\\\").replaceAll("'", "'\\''").replaceAll(":", "\\:");
  const commandFilter = commands.length ? `sendcmd=f='${escaped}',` : "";
  const maskDuration = options.previewAt === undefined ? options.duration : 1;
  return { ...above,
    filters: ["[base]split=2[lowerbase][originalforeground]", ...under.filters.map(rename),
      `color=c=black:s=${options.width}x${options.height}:r=30:d=${maskDuration},format=gray,${commandFilter}${first.map((rect,i)=>`drawbox@sourceplane${i}=x=${rect.x}:y=${rect.y}:w=${rect.w}:h=${rect.h}:color=white:t=fill`).join(",")}[sourceplanemask]`,
      "[originalforeground]format=rgba[foregroundrgba]",
      "[foregroundrgba][sourceplanemask]alphamerge[sharpsource]",
      `[${underLabel}][sharpsource]overlay=0:0[upperbase]`, ...above.filters],
    audioFilters: [...under.audioFilters.map(rename), ...above.audioFilters],
    audioLabels: [...under.audioLabels.map(label => `lower_${label}`), ...above.audioLabels],
  };
}
