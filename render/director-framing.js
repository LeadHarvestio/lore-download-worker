import { layoutFilter, sourceSettings, foregroundGeometry } from "./framing.js";
import { segmentFramingFilter } from "./segment-framing.js";
import { smoothFaceTrack, trackedForegroundGeometry } from "./face-tracking-core.js";
import { trackExpression } from "./tracking-framing.js";
import { sourceVideoFilter } from "./video-filters.js";
import { zoomExpression } from "./director-motion.js";
const even = n => Math.max(2, Math.round(n / 2) * 2);
function viewport(layout, width, height, sw, sh, source, look, effects, at, origin=0) {
  const s = sourceSettings(source), tracking = s.tracking?.enabled ? s.tracking : null;
  const time = at === undefined ? `(t+${origin})` : String(at);
  const g = foregroundGeometry(sw, sh, width, height, s, layout);
  const left = Math.floor(sw*s.cropLeftPct/100/2)*2, top = Math.floor(sh*s.cropTopPct/100/2)*2;
  let fw = g.width, fh = g.height, x = `W*${s.xPct/100}-w/2`, y = `H*${s.yPct/100}-h/2`;
  if (tracking) {
    const geo = trackedForegroundGeometry(sw,sh,width,height,layout,s,tracking,{t:0,x:.5,y:.5});
    fw = geo.foregroundWidth; fh = geo.foregroundHeight;
    const points = smoothFaceTrack(tracking, Math.max(tracking.endSeconds,...tracking.track.map(p=>p.t),.1));
    const cx = trackExpression(points,"x",time), cy = trackExpression(points,"y",time);
    const vh = layout === "fill" ? height : Math.min(height, fh/Math.max(s.zoom,tracking.zoom));
    x = `min(max(${width/2}-${fw}*((${sw}*(${cx})-${left})/${g.croppedWidth}),${Math.min(0,width-fw)}),${Math.max(0,(width-fw)/2)})`;
    y = `min(max(${height/2}-${fh}*((${sh}*(${cy})-${top})/${g.croppedHeight}),${(height-vh)/2+vh-fh}),${(height-vh)/2})`;
  }
  const zooms = effects.filter(e=>e.type==="zoom"), scale = zoomExpression(zooms,time);
  if (!tracking) { x = `W*${s.xPct/100}-${fw/2}`; y = `H*${s.yPct/100}-${fh/2}`; }
  let ax = ".5", ay = ".35";
  for (const e of zooms) {
    const active = `gte(${time},${e.startSeconds})*lt(${time},${e.endSeconds})`;
    ax = `if(${active},${e.anchor.x},${ax})`; ay = `if(${active},${e.anchor.y},${ay})`;
  }
  // Evaluate only once per frame. Blur background never participates in zoom.
  const fg = `crop=${g.croppedWidth}:${g.croppedHeight}:${left}:${top},${sourceVideoFilter(look)}scale=w='max(2,trunc(${fw}*(${scale})/2)*2)':h='max(2,trunc(${fh}*(${scale})/2)*2)':eval=frame,setsar=1`;
  const filters = layout === "fill" ? [
    `[0:v]fps=30,${fg}[fg]`, `color=c=black:s=${width}x${height}:r=30[bg]`,
  ] : [
    "[0:v]fps=30,split=2[rawbg][rawfg]",
    `[rawbg]crop=${g.croppedWidth}:${g.croppedHeight}:${left}:${top},scale=${even(width/4)}:${even(height/4)}:force_original_aspect_ratio=increase,crop=${even(width/4)}:${even(height/4)},boxblur=${Math.round(10*width/1080)}:6,eq=brightness=-0.12:saturation=1.1,scale=${width}:${height}[bg]`,
    `[rawfg]${fg}[fg]`,
  ];
  filters.push(`[bg][fg]overlay=x='(${x})-(w-${fw})*(${ax})':y='(${y})-(h-${fh})*(${ay})':eval=frame:shortest=1[base]`);
  return filters.join(";");
}
export function directorFramingFilter(style,width,height,sw,sh,source,edit,at) {
  if (!style.sourcePanes && !style.effects?.some(e=>e.type==="zoom") && !edit?.segments.some(s=>s.punchScale))
    return segmentFramingFilter(style.layout,width,height,sw,sh,source,style.videoFilter,edit,at);
  const frame = (layout,w,h,s,look,time,origin) => viewport(layout,w,h,sw,sh,s,look,style.effects || [],time,origin);
  if (!style.sourcePanes)
    return segmentFramingFilter(style.layout,width,height,sw,sh,source,style.videoFilter,edit,at,frame);
  const panes = style.sourcePanes, h = even(height*panes.topPct/100);
  const rename = (graph,prefix,input,output) => graph.replace(/\[([^\]]+)\]/g,(_,label)=>
    label==="0:v"?`[${input}]`:label==="base"?`[${output}]`:`[${prefix}${label}]`);
  const filters = ["[0:v]split=2[paneTop][paneBottom]"];
  for (const [key,ph] of [["top",h],["bottom",height-h]]) {
    const pane = panes[key], {tracking: _ignored, ...manual} = source, s = {...manual,...(pane.tracking ? {tracking:pane.tracking} : {})};
    const render = (layout,w,hh,ss,look,time,origin) => viewport(layout,w,hh,sw,sh,ss,look,style.effects || [],time,origin);
    filters.push(rename(segmentFramingFilter(pane.mode,width,ph,sw,sh,s,style.videoFilter,edit,at,render),
      key,key==="top"?"paneTop":"paneBottom",`${key}out`));
  }
  filters.push("[topout][bottomout]vstack=inputs=2[base]");
  return filters.join(";");
}
