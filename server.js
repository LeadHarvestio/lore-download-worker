import express from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";
import os from "os";
import { processVideo, previewFrame, validateStyleInput } from "./video-processor.js";
import { PRESETS, FONTS } from "./render/styles.js";
import { OUT_W, OUT_H, FPS, PREVIEW_W, PREVIEW_H } from "./render/process.js";
import { transcriptionAudio } from "./render/transcription-audio.js";
import { createDownloadQueue } from "./download/queue.js";
import { downloadErrorMessage } from "./download/errors.js";
import { resolveTikTokVideoUrl } from "./download/tiktok.js";
import { livePreviewRecipe } from "./render/live-preview.js";
import { FONT_DIR } from "./render/headline.js";
import { orderRenderJobs } from "./render/priority.js";

var execFileAsync = promisify(execFile);
var app = express();
app.use(express.json({ limit: "2mb" }));

var API_KEY = process.env.API_KEY || "";
var DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "/tmp/downloads";
var jobs = new Map();
var downloadQueue = createDownloadQueue({
  concurrency: 2,
  run: processDownload,
  onStart: function(jobId) {
    jobs.set(jobId, { ...jobs.get(jobId), status: "downloading", startedAt: Date.now() });
  },
  onError: function(jobId, error) {
    jobs.set(jobId, { ...jobs.get(jobId), status: "failed", error: downloadErrorMessage(error), failedAt: Date.now() });
  },
});
var processJobs = new Map();
var processQueue = [];
var activeProcesses = 0;
var maxConcurrentProcesses = Math.max(1, Number(process.env.MAX_CONCURRENT_RENDERS || 1));
var processCleanupTimers = new Map();

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function auth(req, res, next) {
  if (API_KEY && req.headers.authorization !== "Bearer " + API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/", function(_req, res) {
  res.json({
    service: "lore-download-worker",
    status: "running",
    jobs: jobs.size,
    uptime: Math.round(process.uptime())
  });
});

app.get("/health", function(_req, res) {
  res.json({ status: "ok" });
});

// Debug endpoint - see what files exist
app.get("/api/debug/files", auth, function(_req, res) {
  try {
    var files = fs.readdirSync(DOWNLOAD_DIR).map(function(f) {
      var stat = fs.statSync(path.join(DOWNLOAD_DIR, f));
      return { name: f, size: stat.size, age: Date.now() - stat.mtimeMs };
    });
    res.json({ dir: DOWNLOAD_DIR, files: files, jobCount: jobs.size });
  } catch (e) {
    res.json({ dir: DOWNLOAD_DIR, files: [], error: e.message });
  }
});

app.post("/api/download", auth, function(req, res) {
  var body = req.body;
  var assetId = body.assetId;
  var sourceUrl = body.sourceUrl;
  var startTrim = body.startTrim;
  var endTrim = body.endTrim;
  var maxDuration = body.maxDuration;

  if (assetId !== undefined && (typeof assetId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(assetId))) {
    return res.status(400).json({ error: "assetId must contain 1–128 letters, numbers, underscores, or hyphens." });
  }
  if (!sourceUrl) {
    return res.status(400).json({ error: "sourceUrl is required" });
  }

  var jobId = crypto.randomUUID();
  jobs.set(jobId, { status: "queued", assetId: assetId, sourceUrl: sourceUrl, queuedAt: Date.now() });
  downloadQueue.enqueue(jobId, {
    assetId: assetId || jobId,
    sourceUrl: sourceUrl,
    startTrim: startTrim,
    endTrim: endTrim,
    maxDuration: maxDuration || 300
  });
  res.json({ jobId: jobId, status: jobs.get(jobId).status, queuePosition: downloadQueue.position(jobId) });
});

app.get("/api/status/:jobId", auth, function(req, res) {
  var job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json({ ...job, queuePosition: downloadQueue.position(req.params.jobId) });
});

app.get("/api/file/:filename", auth, function(req, res) {
  var filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, "");
  var filePath = path.join(DOWNLOAD_DIR, filename);

  // Try exact match first
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }

  // Try finding by assetId prefix (without extension)
  var baseName = filename.replace(/\.[^.]+$/, "");
  try {
    var files = fs.readdirSync(DOWNLOAD_DIR);
    for (var i = 0; i < files.length; i++) {
      if (files[i].startsWith(baseName)) {
        console.log("[File] Fuzzy match: requested " + filename + " -> serving " + files[i]);
        return res.sendFile(path.join(DOWNLOAD_DIR, files[i]));
      }
    }
  } catch (e) {
    // ignore
  }

  console.log("[File] 404 for: " + filename + " (files in dir: " + (fs.readdirSync(DOWNLOAD_DIR).join(", ") || "none") + ")");
  res.status(404).json({ error: "File not found", requested: filename });
});

function publicProcessJob(job) {
  processQueue = orderRenderJobs(processQueue, processJobs);
  if (job.status === "completed") {
    return {
      jobId: job.jobId,
      status: job.status,
      downloadUrl: job.downloadUrl,
      filename: job.filename,
      srtPath: job.srtPath || null,
      durationSeconds: job.durationSeconds,
      captionWordCount: job.captionWordCount,
      words: job.words || null,
      censorship: job.censorship,
      renderStats: job.renderStats,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
    };
  }
  if (job.status === "failed") {
    return { jobId: job.jobId, status: job.status, error: job.error };
  }
  return {
    jobId: job.jobId, status: job.status, queuedAt: job.queuedAt, startedAt: job.startedAt,
    queuePosition: job.status === "queued" ? processQueue.indexOf(job.jobId) + 1 : null,
  };
}

function scheduleProcessedFileCleanup(jobId, filenames) {
  const previous = processCleanupTimers.get(jobId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(function() {
    for (const filename of filenames) {
      const filePath = path.join(DOWNLOAD_DIR, filename);
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (error) {
        console.warn("[Process] Cleanup failed for " + filename + ": " + error.message);
      }
    }
    processJobs.delete(jobId);
    processCleanupTimers.delete(jobId);
  }, 4 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
  processCleanupTimers.set(jobId, timer);
}

function startQueuedProcessJobs() {
  processQueue = orderRenderJobs(processQueue, processJobs);
  while (activeProcesses < maxConcurrentProcesses && processQueue.length) {
    const jobId = processQueue.shift();
    const job = processJobs.get(jobId);
    if (!job || job.status !== "queued") continue;
    activeProcesses++;
    job.status = "processing";
    job.startedAt = Date.now();

    const outputFilename = "processed_" + jobId + ".mp4";
    const outputPath = path.join(DOWNLOAD_DIR, outputFilename);
    Promise.resolve().then(function() {
      return processVideo({
        jobId: jobId,
        clipPath: path.join(DOWNLOAD_DIR, job.clipFilename),
        outputPath: outputPath,
        headline: job.headline,
        highlightWords: job.highlightWords,
        musicUrl: job.musicUrl,
        musicVolumeDb: job.musicVolumeDb,
        stylePresetId: job.stylePresetId,
        styleOverrides: job.styleOverrides,
        words: job.words,
        censorCaptions: job.censorCaptions,
        muteExpletives: job.muteExpletives,
      });
    }).then(function(result) {
      const srtFilename = result.srtPath ? path.basename(result.srtPath) : null;
      const completed = {
        ...job,
        status: "completed",
        downloadUrl: "/api/file/" + outputFilename,
        filename: outputFilename,
        srtPath: srtFilename ? "/api/file/" + srtFilename : null,
        durationSeconds: result.durationSeconds,
        outputWidth: result.outputWidth,
        outputHeight: result.outputHeight,
        captionWordCount: result.captionWordCount,
        renderStats: result.renderStats,
        words: result.words,
        censorship: result.censorship,
        completedAt: Date.now(),
      };
      delete completed.clipFilename;
      delete completed.headline;
      delete completed.highlightWords;
      delete completed.musicUrl;
      delete completed.musicVolumeDb;
      delete completed.stylePresetId;
      delete completed.styleOverrides;
      processJobs.set(jobId, completed);
      scheduleProcessedFileCleanup(jobId, [outputFilename, ...(srtFilename ? [srtFilename] : [])]);
      console.log("[Process] Complete: " + jobId + " -> " + outputFilename);
    }).catch(function(error) {
      const message = (error && error.message ? error.message : "Unknown video processing error").slice(0, 900);
      processJobs.set(jobId, {
        jobId: jobId,
        status: "failed",
        error: message,
        failedAt: Date.now(),
      });
      console.error("[Process] Failed: " + jobId + " - " + message);
      setTimeout(function() {
        const current = processJobs.get(jobId);
        if (current && current.status === "failed") processJobs.delete(jobId);
      }, 60 * 60 * 1000).unref?.();
    }).finally(function() {
      activeProcesses--;
      startQueuedProcessJobs();
    });
  }
}

app.post("/api/process", auth, function(req, res) {
  const body = req.body || {};
  const jobId = body.jobId;
  const clipFilename = body.clipFilename;
  const headline = typeof body.headline === "string" ? body.headline.trim() : "";
  const highlightWords = body.highlightWords;
  const musicUrl = body.musicUrl == null || body.musicUrl === "" ? null : body.musicUrl;

  if (typeof jobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
    return res.status(400).json({ error: "jobId must contain 1–128 letters, numbers, underscores, or hyphens." });
  }
  if (typeof clipFilename !== "string" ||
      clipFilename !== path.basename(clipFilename) ||
      !/^[A-Za-z0-9._-]{1,180}$/.test(clipFilename) ||
      !/\.(mp4|m4v|mov|webm)$/i.test(clipFilename)) {
    return res.status(400).json({ error: "clipFilename must be the name of a supported video already downloaded to this worker." });
  }
  if (!headline || headline.length > 80) {
    return res.status(400).json({ error: "headline must be between 1 and 80 characters." });
  }
  if (!Array.isArray(highlightWords) || highlightWords.length > 10 ||
      highlightWords.some(function(word) { return typeof word !== "string" || word.length > 60; })) {
    return res.status(400).json({ error: "highlightWords must be an array of up to 10 strings." });
  }
  if (musicUrl !== null && typeof musicUrl !== "string") {
    return res.status(400).json({ error: "musicUrl must be an HTTP(S) URL or null." });
  }
  if (musicUrl !== null) {
    try {
      const parsedMusicUrl = new URL(musicUrl);
      if (!["http:", "https:"].includes(parsedMusicUrl.protocol) || parsedMusicUrl.username || parsedMusicUrl.password) {
        return res.status(400).json({ error: "musicUrl must be an HTTP(S) URL without embedded credentials." });
      }
    } catch (_error) {
      return res.status(400).json({ error: "musicUrl must be a valid HTTP(S) URL or null." });
    }
  }
  if (body.captionStyle !== undefined && body.captionStyle !== "word-by-word") {
    return res.status(400).json({ error: "captionStyle must be word-by-word." });
  }
  if (body.outputAspectRatio !== undefined && body.outputAspectRatio !== "9:16") {
    return res.status(400).json({ error: "outputAspectRatio must be 9:16." });
  }
  const musicVolumeDb = body.musicVolumeDb === undefined ? -15 : body.musicVolumeDb;
  if (body.priority !== undefined && !["batch", "interactive"].includes(body.priority)) {
    return res.status(400).json({ error: "priority must be batch or interactive." });
  }
  if (typeof musicVolumeDb !== "number" || !(musicVolumeDb >= -30 && musicVolumeDb <= -5)) {
    return res.status(400).json({ error: "musicVolumeDb must be a number between -30 and -5." });
  }
  const stylePresetId = body.stylePresetId || "boxed_red";
  if (!PRESETS[stylePresetId]) {
    return res.status(400).json({ error: "stylePresetId must be one of: " + Object.keys(PRESETS).join(", ") });
  }
  const styleOverrides = body.styleOverrides === undefined || body.styleOverrides === null ? {} : body.styleOverrides;
  try { validateStyleInput(stylePresetId, styleOverrides); } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  if (body.words !== undefined && body.words !== null &&
      (!Array.isArray(body.words) || body.words.length > 3000)) {
    return res.status(400).json({ error: "words must be an array of up to 3000 {word,start,end} items." });
  }
  for (const key of ["censorCaptions", "muteExpletives"]) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") return res.status(400).json({ error: key + " must be a boolean." });
  }

  const existing = processJobs.get(jobId);
  if (existing && (existing.status === "queued" || existing.status === "processing")) {
    return res.status(202).json(publicProcessJob(existing));
  }
  if (existing && existing.status === "completed") {
    return res.status(200).json({ jobId: jobId, status: "completed" });
  }

  const clipPath = path.resolve(DOWNLOAD_DIR, clipFilename);
  if (!clipPath.startsWith(path.resolve(DOWNLOAD_DIR) + path.sep) || !fs.existsSync(clipPath) || !fs.statSync(clipPath).isFile()) {
    return res.status(404).json({ error: "Downloaded clip was not found on this worker." });
  }

  processJobs.set(jobId, {
    jobId: jobId,
    status: "queued",
    clipFilename: clipFilename,
    headline: headline,
    highlightWords: highlightWords,
    musicUrl: musicUrl,
    musicVolumeDb: musicVolumeDb,
    stylePresetId: stylePresetId,
    styleOverrides: styleOverrides,
    words: Array.isArray(body.words) ? body.words : null,
    censorCaptions: body.censorCaptions ?? false,
    muteExpletives: body.muteExpletives ?? false,
    priority: body.priority || "batch",
    queuedAt: Date.now(),
  });
  processQueue.push(jobId);
  setImmediate(startQueuedProcessJobs);
  return res.status(202).json(publicProcessJob(processJobs.get(jobId)));
});

app.get("/api/process/queue", auth, function(_req, res) {
  res.json({ active: activeProcesses, queued: processQueue.length, limit: maxConcurrentProcesses });
});

app.get("/api/process/status/:jobId", auth, function(req, res) {
  const job = processJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: "failed", error: "Processing job was not found on this worker." });
  return res.json(publicProcessJob(job));
});

let audioSampleBusy = false;
app.get("/api/transcription-audio/:filename", auth, async function(req, res) {
  if (!API_KEY) return res.status(503).json({ error: "Configure worker API authentication before extracting test audio." });
  if (audioSampleBusy) return res.status(409).json({ error: "Another audio sample is being prepared." });
  const name = req.params.filename;
  if (name !== path.basename(name) || !/^[A-Za-z0-9._-]{1,180}\.(mp4|m4v|mov|webm)$/i.test(name)) {
    return res.status(400).json({ error: "Invalid source filename." });
  }
  const file = path.resolve(DOWNLOAD_DIR, name);
  if (!file.startsWith(path.resolve(DOWNLOAD_DIR) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return res.status(404).json({ error: "Original source is no longer on the worker; download it again before testing." });
  }
  audioSampleBusy = true;
  try {
    const sample = await transcriptionAudio(file);
    res.set({ "Content-Type": "audio/wav", "Cache-Control": "no-store",
      "X-Source-Duration": String(sample.sourceDuration), "X-Sample-Duration": String(sample.sampleDuration),
      "X-Complete-Sample": sample.complete ? "1" : "0" });
    return res.send(sample.audio);
  } catch {
    return res.status(422).json({ error: "Could not extract original audio; verify the source has an audio track." });
  } finally { audioSampleBusy = false; }
});

app.get("/api/styles", auth, function(_req, res) {
  res.json({ presets: PRESETS, fonts: Object.keys(FONTS), output: { width: OUT_W, height: OUT_H, fps: FPS, previewWidth: PREVIEW_W, previewHeight: PREVIEW_H }, capabilities: { censorship: 1, audioMuteFrameMs: 10, headerLayout: 2, captionPreviewTiming: 1, sourceEditing: 1, transcriptionAudio: 1, downloadQueue: 1, maxConcurrentDownloads: 2, renderQueue: 1, maxConcurrentRenders: maxConcurrentProcesses, livePreview: 1, interactiveRenderPriority: 1, advancedEditing: 1, subscribeOverlays: 1, captionReference: 1 } });
});

app.get("/api/styles/fonts/:id", auth, function(req, res) {
  const font = Object.hasOwn(FONTS, req.params.id) ? FONTS[req.params.id] : null;
  if (!font) return res.status(404).json({ error: "Unknown preview font." });
  return res.type(font.file.endsWith(".otf") ? "font/otf" : "font/ttf").sendFile(path.join(FONT_DIR, font.file), { dotfiles: "allow" });
});

app.post("/api/live-preview", auth, function(req, res) {
  try {
    const body = req.body || {};
    validateStyleInput(body.stylePresetId, body.styleOverrides);
    if (typeof body.headline !== "string" || !body.headline.trim() || body.headline.length > 80) throw new Error("Provide a headline of up to 80 characters.");
    if (body.censorCaptions !== undefined && typeof body.censorCaptions !== "boolean") throw new Error("censorCaptions must be boolean.");
    if (body.highlightWords !== undefined && (!Array.isArray(body.highlightWords) || body.highlightWords.length > 10 || body.highlightWords.some(w => typeof w !== "string" || w.length > 60))) throw new Error("Invalid headline highlights.");
    if (body.words !== undefined && (!Array.isArray(body.words) || body.words.length > 5000 || body.words.some(w =>
      typeof w?.word !== "string" || w.word.length > 200 || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < 0 || w.end < w.start))) throw new Error("Invalid cached caption words.");
    return res.set("Cache-Control", "no-store").json(livePreviewRecipe(body));
  } catch (error) {
    return res.status(400).json({ error: String(error.message).slice(0, 250) });
  }
});

// Synchronous one-frame PNG of a style, for the Review page live preview.
app.post("/api/preview", auth, async function(req, res) {
  const body = req.body || {};
  if (body.censorCaptions !== undefined && typeof body.censorCaptions !== "boolean") return res.status(400).json({ error: "censorCaptions must be a boolean." });
  const workDir = path.join(os.tmpdir(), "preview-" + crypto.randomUUID());
  try {
    let clipPath = null;
    if (body.clipFilename) {
      const name = String(body.clipFilename);
      const resolved = path.resolve(DOWNLOAD_DIR, name);
      if (name !== path.basename(name) || !resolved.startsWith(path.resolve(DOWNLOAD_DIR) + path.sep) || !fs.existsSync(resolved)) {
        return res.status(404).json({ error: "Downloaded clip was not found on this worker." });
      }
      clipPath = resolved;
    }
    const presetId = body.stylePresetId || "boxed_red";
    if (!PRESETS[presetId]) return res.status(400).json({ error: "Unknown stylePresetId." });
    fs.mkdirSync(workDir, { recursive: true });
    const out = path.join(workDir, "preview.png");
    await previewFrame({
      clipPath, outputPath: out, workDir,
      headline: typeof body.headline === "string" ? body.headline : "",
      highlightWords: Array.isArray(body.highlightWords) ? body.highlightWords.map(String) : [],
      words: Array.isArray(body.words) ? body.words.slice(0, 200) : null,
      censorCaptions: body.censorCaptions ?? false,
      stylePresetId: presetId,
      styleOverrides: body.styleOverrides || {},
      at: Number(body.at) || 0,
    });
    res.set("X-Censorship-Captions", String(body.censorCaptions ?? false)).type("png").send(fs.readFileSync(out));
  } catch (error) {
    res.status(500).json({ error: String(error.stderr || error.message || "preview failed").slice(0, 500) });
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, function() {});
  }
});

app.get("/api/jobs", auth, function(_req, res) {
  var allJobs = [];
  for (var entry of jobs.entries()) {
    allJobs.push({ jobId: entry[0], kind: "download", status: entry[1].status, assetId: entry[1].assetId });
  }
  for (const [jobId, job] of processJobs.entries()) {
    allJobs.push({ jobId, kind: "render", status: job.status });
  }
  res.json(allJobs);
});

function isDirectImage(sourceUrl) {
  var urlLower = sourceUrl.toLowerCase().split("?")[0];
  var imageExts = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"];
  for (var i = 0; i < imageExts.length; i++) {
    if (urlLower.endsWith(imageExts[i])) return true;
  }
  return false;
}

function isDirectVideo(sourceUrl) {
  try {
    return [".mp4", ".m4v", ".mov", ".webm"].includes(path.extname(new URL(sourceUrl).pathname).toLowerCase());
  } catch (_error) {
    return false;
  }
}

function findOutputFile(assetId) {
  // yt-dlp sometimes modifies the output filename
  // Search for any file matching the assetId prefix
  try {
    var files = fs.readdirSync(DOWNLOAD_DIR);
    for (var i = 0; i < files.length; i++) {
      if (files[i].startsWith(assetId + ".") && [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(path.extname(files[i]).toLowerCase())) {
        return path.join(DOWNLOAD_DIR, files[i]);
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
}

async function processDownload(jobId, params) {
  var assetId = params.assetId;
  var sourceUrl = params.sourceUrl;
  var startTrim = params.startTrim;
  var endTrim = params.endTrim;
  var maxDuration = params.maxDuration;
  var baseOutput = path.join(DOWNLOAD_DIR, assetId);

  try {
    console.log("[Download] Starting: " + assetId + " - " + sourceUrl);

    // Clean up previous attempts
    var cleanExts = [".mp4", ".m4v", ".mov", ".webm", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".part", ".mp4.part", ".webm.part", ".m4a.part", ".ytdl", ".temp.mp4"];
    for (var i = 0; i < cleanExts.length; i++) {
      var p = baseOutput + cleanExts[i];
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    var outputPath;
    var isImage = false;

    if (isDirectImage(sourceUrl)) {
      console.log("[Download] Detected image URL, downloading directly: " + assetId);
      outputPath = await downloadDirectFile(assetId, sourceUrl);
      isImage = true;
    } else if (isDirectVideo(sourceUrl)) {
      console.log("[Download] Detected direct video URL: " + assetId);
      outputPath = await downloadDirectVideo(assetId, sourceUrl);
    } else {
      outputPath = await downloadWithYtDlp(assetId, sourceUrl, startTrim, endTrim, maxDuration);
    }

    // If the expected path doesn't exist, search for it
    if (!outputPath || !fs.existsSync(outputPath)) {
      outputPath = findOutputFile(assetId);
    }

    if (!outputPath || !fs.existsSync(outputPath)) {
      throw new Error("The downloader finished without a usable video file.");
    }

    var stats = fs.statSync(outputPath);
    var filename = path.basename(outputPath);

    var duration = 0;
    if (!isImage) {
      try {
        var probe = await execFileAsync("ffprobe", [
          "-v", "quiet",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          outputPath
        ]);
        duration = parseFloat(probe.stdout.trim()) || 0;
      } catch (e) {
        // duration unknown
      }
    }

    jobs.set(jobId, {
      status: "completed",
      assetId: assetId,
      downloadUrl: "/api/file/" + filename,
      filename: filename,
      fileSizeBytes: stats.size,
      durationSeconds: duration,
      isImage: isImage,
      completedAt: Date.now()
    });

    console.log("[Download] Complete: " + assetId + " -> " + filename + " (" + (stats.size / 1024 / 1024).toFixed(1) + "MB)");

    // Clean up after 4 hours (increased from 2)
    setTimeout(function() {
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
      jobs.delete(jobId);
    }, 24 * 60 * 60 * 1000);

  } catch (error) {
    var errMsg = downloadErrorMessage(error);

    console.error("[Download] Failed: " + assetId + " - " + errMsg);

    jobs.set(jobId, {
      status: "failed",
      assetId: assetId,
      error: errMsg,
      failedAt: Date.now()
    });

    var failExts = [".mp4", ".m4v", ".mov", ".webm", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".part", ".mp4.part", ".webm.part", ".m4a.part", ".ytdl", ".temp.mp4"];
    for (var j = 0; j < failExts.length; j++) {
      var fp = baseOutput + failExts[j];
      if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (e) {} }
    }

    setTimeout(function() { jobs.delete(jobId); }, 60 * 60 * 1000);
  }
}

async function downloadDirectFile(assetId, sourceUrl) {
  var parsedUrl = new URL(sourceUrl);
  var urlPath = parsedUrl.pathname.toLowerCase();
  var ext = ".jpg";
  if (urlPath.endsWith(".png")) ext = ".png";
  else if (urlPath.endsWith(".webp")) ext = ".webp";
  else if (urlPath.endsWith(".gif")) ext = ".gif";
  else if (urlPath.endsWith(".jpeg")) ext = ".jpeg";

  var outputPath = path.join(DOWNLOAD_DIR, assetId + ext);

  var response = await fetch(sourceUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "image/*,*/*"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status + ": " + response.statusText);
  }

  var buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length < 100) {
    throw new Error("Downloaded file is too small (" + buffer.length + " bytes) - likely an error page");
  }

  fs.writeFileSync(outputPath, buffer);
  console.log("[Download] Image saved: " + outputPath + " (" + buffer.length + " bytes)");

  return outputPath;
}

async function downloadDirectVideo(assetId, sourceUrl) {
  const parsedUrl = new URL(sourceUrl);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Direct video URL must use HTTP or HTTPS.");
  }
  const extension = path.extname(parsedUrl.pathname).toLowerCase();
  const outputPath = path.join(DOWNLOAD_DIR, assetId + extension);
  const maxBytes = 1024 * 1024 * 1024;
  const response = await fetch(sourceUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "video/*,*/*"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Direct video download failed with HTTP " + response.status + ".");
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    await response.body.cancel();
    throw new Error("Direct video exceeds the 1 GB worker limit.");
  }

  let bytes = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > maxBytes ? new Error("Direct video exceeds the 1 GB worker limit.") : null, chunk);
        }
      }),
      fs.createWriteStream(outputPath),
    );
  } catch (error) {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_cleanupError) {}
    throw error;
  }
  if (bytes < 100) {
    try { fs.unlinkSync(outputPath); } catch (_cleanupError) {}
    throw new Error("Downloaded video is too small to be valid.");
  }
  return outputPath;
}

async function downloadWithYtDlp(assetId, sourceUrl, startTrim, endTrim, maxDuration) {
  sourceUrl = await resolveTikTokVideoUrl(sourceUrl);
  var outputTemplate = path.join(DOWNLOAD_DIR, assetId + ".%(ext)s");
  var expectedMp4 = path.join(DOWNLOAD_DIR, assetId + ".mp4");

  var args = [
    "-f", "bestvideo[height<=1080][vcodec^=avc]+bestaudio/best[height<=1080]/best",
    "--merge-output-format", "mp4",
    "--no-playlist",
    "--retries", "3",
    "--socket-timeout", "30",
    "--no-warnings",
    "--downloader-args", "ffmpeg_o:-threads 2 -filter_threads 1 -filter_complex_threads 1",
    "--postprocessor-args", "ffmpeg_o:-threads 2 -filter_threads 1 -filter_complex_threads 1",
    "-o", outputTemplate
  ];

  if (new URL(sourceUrl).hostname === "www.tiktok.com") {
    args.push("--impersonate", "chrome", "--user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
  }

  if (startTrim !== undefined && endTrim !== undefined && endTrim > startTrim) {
    args.push("--download-sections", "*" + startTrim + "-" + endTrim);
    args.push("--force-keyframes-at-cuts");
  } else if (maxDuration && maxDuration < 600) {
    args.push("--download-sections", "*0-" + maxDuration);
    args.push("--force-keyframes-at-cuts");
  }

  args.push(sourceUrl);

  console.log("[yt-dlp] Running: yt-dlp " + args.join(" ").slice(0, 200) + "...");

  try {
    var result = await execFileAsync("yt-dlp", args, {
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024
    });
    if (result.stdout) console.log("[yt-dlp] stdout: " + result.stdout.slice(0, 500));
  } catch (err) {
    // A .part or partially written MP4 is not a successful download.
    throw new Error(downloadErrorMessage(err));
  }

  // Check for the expected .mp4 file
  if (fs.existsSync(expectedMp4)) {
    return expectedMp4;
  }

  // yt-dlp might have used a different extension - find it
  var found = findOutputFile(assetId);
  if (found) {
    console.log("[yt-dlp] Found output at: " + found + " (expected: " + expectedMp4 + ")");

    // If it's not mp4, try to convert
    if (!found.endsWith(".mp4")) {
      var convertedPath = expectedMp4;
      try {
        await execFileAsync("ffmpeg", [
          "-i", found,
          "-c:v", "libx264", "-preset", "fast", "-crf", "22", "-threads", "2", "-filter_threads", "1",
          "-c:a", "aac", "-b:a", "192k",
          "-y", convertedPath
        ], { timeout: 120000 });
        fs.unlinkSync(found);
        return convertedPath;
      } catch (convertErr) {
        throw new Error("Downloaded video could not be converted to MP4: " + downloadErrorMessage(convertErr));
      }
    }

    return found;
  }

  throw new Error("Downloader reported success but no playable video file was produced for this clip.");
}

var PORT = process.env.PORT || 3001;
var listeningServer = app.listen(PORT, "0.0.0.0", function() {
  console.log("Download worker running on port " + listeningServer.address().port);
  console.log("Auth: " + (API_KEY ? "enabled" : "disabled (set API_KEY env var to enable)"));
});
