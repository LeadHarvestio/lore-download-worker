import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { lookup } from "node:dns/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const ROOT = path.resolve("uploads", "context-assets");
const UUID = /^[a-f0-9-]{36}$/;
const HEX = /^#[a-f0-9]{6}$/i;
const pending = new Map();
const active = (start, end, offset) => `between(t+${offset},${start},${end})`;
export function validateAssetUrl(value, assetId) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !/\.(replit\.app|replit\.dev)$/.test(url.hostname) ||
      url.pathname !== `/api/editing-assets/${assetId}/file` || url.search) throw new Error("Invalid context asset URL.");
  return url;
}
const privateIP = ip => /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|224\.|255\.|::|f[cd]|fe80)/i.test(ip) ||
  ip.includes("::ffff:") || /^(100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.(18|19)\.)/.test(ip);
async function downloadAsset(layer) {
  if (!UUID.test(layer.assetId)) throw new Error("Invalid context asset identity.");
  let url = validateAssetUrl(layer.assetUrl, layer.assetId);
  const key = createHash("sha256").update(url.href).digest("hex");
  const dest = path.join(ROOT, `${key}.${layer.kind === "cutout" ? "png" : "mp4"}`);
  await fs.mkdir(ROOT, { recursive: true });
  if (await fs.stat(dest).catch(() => null)) return dest;
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    const temp = `${dest}.${randomUUID()}.tmp`;
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        const addresses = await lookup(url.hostname, { all: true });
        if (!addresses.length || addresses.some(a => privateIP(a.address))) throw new Error("Context asset resolved to a private network.");
        const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(180000) });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          url = validateAssetUrl(new URL(response.headers.get("location"), url).href, layer.assetId);
          continue;
        }
        if (!response.ok || !response.body) throw new Error(`Context asset download failed (${response.status}).`);
        await pipeline(Readable.fromWeb(response.body), (await import("node:fs")).createWriteStream(temp));
        await fs.rename(temp, dest);
        return dest;
      }
      throw new Error("Too many context asset redirects.");
    } finally { await fs.rm(temp, { force: true }); }
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}

// Alpha-silhouette dilation produces a clean white edge; the blurred halo is
// separate, so a glow never turns into a rectangular PNG border.
export async function edgedCutout(file, width, glow, cacheDir = ROOT) {
  if (!glow?.enabled) return file;
  const hash = createHash("sha256").update(JSON.stringify([file, width, glow])).digest("hex");
  const dest = path.join(cacheDir, `${hash}.png`);
  if (await fs.stat(dest).catch(() => null)) return dest;
  const image = await loadImage(file);
  const height = Math.round(image.height * width / image.width);
  const edge = Math.max(0, Number(glow.widthPct) || 0) * 1080 / 100;
  const blur = Math.max(0, Number(glow.blurPct) || 0) * 1080 / 100;
  const padding = Math.ceil(edge + blur * 2 + 2);
  const silhouette = createCanvas(width, height), mask = silhouette.getContext("2d");
  mask.drawImage(image, 0, 0, width, height); mask.globalCompositeOperation = "source-in";
  mask.fillStyle = HEX.test(glow.color) ? glow.color : "#FFFFFF"; mask.fillRect(0, 0, width, height);
  const output = createCanvas(width + padding * 2, height + padding * 2), ctx = output.getContext("2d");
  ctx.shadowColor = mask.fillStyle; ctx.shadowBlur = blur;
  ctx.drawImage(silhouette, padding, padding); ctx.shadowBlur = 0;
  for (let i = 0; i < 24 && edge > 0; i++) {
    const angle = i * Math.PI / 12;
    ctx.drawImage(silhouette, padding + Math.cos(angle) * edge, padding + Math.sin(angle) * edge);
  }
  ctx.drawImage(image, padding, padding, width, height);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(dest, output.toBuffer("image/png"));
  return dest;
}

export async function prepareCreativeInputs({ style, args, nextIndex, width, height, duration, previewAt, originalPath, originalIndex }, resolver = downloadAsset) {
  const offset = previewAt ?? 0;
  const rawLayers = style.layers || [], effects = style.effects || [];
  if (!Array.isArray(rawLayers) || rawLayers.length > 13 || !Array.isArray(effects) || effects.length > 30) throw new Error("Invalid creative layer count.");
  const layers = rawLayers.map(layer => {
    if (layer.anchor === undefined) return layer;
    if (layer.anchor !== "end" || !Number.isFinite(layer.mediaDurationSeconds) || layer.mediaDurationSeconds <= 0 || layer.mediaDurationSeconds > 10) throw new Error("Invalid end-anchored animation.");
    return { ...layer, startSeconds: Math.max(0, duration - layer.mediaDurationSeconds), endSeconds: duration };
  });
  let index = nextIndex, mainIndex = originalIndex;
  if (layers.some(l => l.mode !== "overlay") && mainIndex === undefined) {
    mainIndex = index++; if (previewAt !== undefined) args.push("-ss", String(previewAt));
    args.push("-i", originalPath);
  }
  const entries = [];
  for (const layer of layers) {
    if (!["cutout", "video"].includes(layer.kind) || !UUID.test(layer.assetId) ||
        !Number.isFinite(layer.startSeconds) || !Number.isFinite(layer.endSeconds) || layer.endSeconds <= layer.startSeconds) throw new Error("Invalid timed context layer.");
    if (previewAt !== undefined && (previewAt < layer.startSeconds || previewAt >= layer.endSeconds)) continue;
    let file = await resolver(layer);
    const targetWidth = Math.max(2, Math.round(width * layer.widthPct / 100));
    if (layer.kind === "cutout") file = await edgedCutout(file, targetWidth, layer.glow);
    if (layer.kind === "cutout") args.push("-loop", "1", "-t", String(layer.endSeconds - layer.startSeconds), "-i", file);
    else {
      const seek = (layer.trimStartSeconds || 0) + (previewAt === undefined ? 0 : previewAt - layer.startSeconds);
      args.push("-ss", String(seek), "-t", String(layer.endSeconds - layer.startSeconds), "-i", file);
    }
    entries.push({ layer, index: index++, edged: layer.kind === "cutout" && layer.glow?.enabled, targetWidth });
  }
  const filters = [], audioFilters = [], audioLabels = []; let current = "base";
  for (const [n, entry] of entries.entries()) {
    const { layer: l, index: input } = entry;
    const label = `context${n}`, output = `contextbase${n}`, start = previewAt === undefined ? l.startSeconds : 0;
    const enable = active(l.startSeconds, l.endSeconds, offset);
    if (l.audio === true && previewAt === undefined) {
      const audioLabel = `contextaudio${n}`;
      audioFilters.push(`[${input}:a]atrim=duration=${l.endSeconds - l.startSeconds},asetpts=PTS-STARTPTS,adelay=${Math.round(l.startSeconds * 1000)}:all=1,apad,atrim=duration=${duration},aformat=sample_rates=44100:channel_layouts=stereo[${audioLabel}]`);
      audioLabels.push(audioLabel);
    }
    const split = l.kind === "video" && l.mode !== "overlay";
    const w = split ? width : Math.round(width * l.widthPct / 100);
    const h = split ? Math.round(height / 2) : Math.round(height * l.heightPct / 100);
    let size = l.kind === "cutout"
      ? entry.edged ? "" : `scale=${w}:-1,`
      : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},`;
    const elapsed = previewAt === undefined ? 0 : previewAt - l.startSeconds;
    let animation = "";
    if (l.enterAnimation === "fade") animation = previewAt === undefined
      ? `fade=t=in:st=0:d=0.15:alpha=1,`
      : `colorchannelmixer=aa=${Math.min(1, elapsed / .15)},`;
    if (l.enterAnimation === "pop") {
      const factor = previewAt === undefined ? "(.82+.18*min(t/0.15\\,1))" : String(.82 + .18 * Math.min(elapsed / .15, 1));
      animation = `scale=w='iw*${factor}':h='ih*${factor}':eval=frame,`;
    }
    filters.push(`[${input}:v]${size}format=rgba,${animation}setpts=PTS-STARTPTS+${start}/TB[${label}]`);
    if (split) {
      const source = style.layout === "fill" ? {} : style.source || {};
      const left = (source.cropLeftPct || 0) / 100, top = (source.cropTopPct || 0) / 100;
      const cw = 1 - left - (source.cropRightPct || 0) / 100, ch = 1 - top - (source.cropBottomPct || 0) / 100;
      const zoom = source.zoom || 1;
      const mainW = Math.ceil(w * zoom / 2) * 2, mainH = Math.ceil(h * zoom / 2) * 2;
      filters.push(`[${mainIndex}:v]crop=iw*${cw}:ih*${ch}:iw*${left}:ih*${top},scale=${mainW}:${mainH}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1[splitmain${n}]`);
      const mainY = l.mode === "split-top" ? h : 0, contextY = l.mode === "split-top" ? 0 : h;
      filters.push(`[${current}][splitmain${n}]overlay=0:${mainY}:enable='${enable}'[splitbase${n}]`);
      filters.push(`[splitbase${n}][${label}]overlay=0:${contextY}:eof_action=pass:enable='${enable}'[${output}]`);
    } else {
      filters.push(`[${current}][${label}]overlay=x=W*${l.xPct / 100}-w/2:y=H*${l.yPct / 100}-h/2:eof_action=pass:enable='${enable}'[${output}]`);
    }
    current = output;
  }
  const shakes = effects.filter(effect => effect.type === "shake");
  if (shakes.length) {
    for (const effect of shakes) if (!Number.isFinite(effect.strengthPct) || effect.strengthPct < 0 || effect.strengthPct > 3 ||
      !Number.isFinite(effect.startSeconds) || !Number.isFinite(effect.endSeconds) || effect.endSeconds <= effect.startSeconds) throw new Error("Invalid shake interval or strength.");
    const maximum = Math.max(...shakes.map(e => width * e.strengthPct / 100));
    const amplitude = shakes.map(e => `${width * e.strengthPct / 100}*${active(e.startSeconds, e.endSeconds, offset)}`).reduce((a, b) => `max(${a},${b})`);
    const enable = shakes.map(e => active(e.startSeconds, e.endSeconds, offset)).join("+");
    const margin = Math.ceil(maximum + 2);
    filters.push(`[${current}]split=2[still][shakeinput]`);
    filters.push(`[shakeinput]scale=${width + margin * 2}:${height + margin * 2},crop=${width}:${height}:x='${margin}+(${amplitude})*sin((t+${offset})*53)':y='${margin}+(${amplitude})*cos((t+${offset})*47)'[shaken]`);
    filters.push(`[still][shaken]overlay=0:0:enable='${enable}'[shakesbase]`);
    current = "shakesbase";
  }
  for (const [n, effect] of effects.entries()) {
    if (effect.type === "shake") continue;
    if (!Number.isFinite(effect.startSeconds) || !Number.isFinite(effect.endSeconds) || effect.endSeconds <= effect.startSeconds) throw new Error("Invalid effect interval.");
    const output = `effect${n}`, enable = active(effect.startSeconds, effect.endSeconds, offset);
    if (effect.type === "flash") {
      if (!HEX.test(effect.color) || !(effect.opacity >= 0 && effect.opacity <= 1)) throw new Error("Invalid flash color or strength.");
      filters.push(`[${current}]drawbox=x=0:y=0:w=iw:h=ih:color=${effect.color.replace("#", "0x")}@${effect.opacity}:t=fill:enable='${enable}'[${output}]`);
    } else throw new Error("Unsupported video effect.");
    current = output;
  }
  return { filters, label: current, nextIndex: index, audioFilters, audioLabels };
}
