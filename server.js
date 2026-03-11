import express from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import crypto from "crypto";

var execFileAsync = promisify(execFile);
var app = express();
app.use(express.json());

var API_KEY = process.env.API_KEY || "";
var DOWNLOAD_DIR = "/tmp/downloads";
var jobs = new Map();

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

  if (!sourceUrl) {
    return res.status(400).json({ error: "sourceUrl is required" });
  }

  var jobId = crypto.randomUUID();
  jobs.set(jobId, { status: "downloading", assetId: assetId, sourceUrl: sourceUrl, startedAt: Date.now() });

  res.json({ jobId: jobId, status: "downloading" });

  processDownload(jobId, {
    assetId: assetId || jobId,
    sourceUrl: sourceUrl,
    startTrim: startTrim,
    endTrim: endTrim,
    maxDuration: maxDuration || 300
  });
});

app.get("/api/status/:jobId", auth, function(req, res) {
  var job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(job);
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

app.get("/api/jobs", auth, function(_req, res) {
  var allJobs = [];
  for (var entry of jobs.entries()) {
    allJobs.push({ jobId: entry[0], status: entry[1].status, assetId: entry[1].assetId });
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

function findOutputFile(assetId) {
  // yt-dlp sometimes modifies the output filename
  // Search for any file matching the assetId prefix
  try {
    var files = fs.readdirSync(DOWNLOAD_DIR);
    for (var i = 0; i < files.length; i++) {
      if (files[i].startsWith(assetId) && !files[i].endsWith(".part") && !files[i].endsWith(".json")) {
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
    var cleanExts = [".mp4", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".part", ".temp.mp4"];
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
    } else {
      outputPath = await downloadWithYtDlp(assetId, sourceUrl, startTrim, endTrim, maxDuration);
    }

    // If the expected path doesn't exist, search for it
    if (!outputPath || !fs.existsSync(outputPath)) {
      outputPath = findOutputFile(assetId);
    }

    if (!outputPath || !fs.existsSync(outputPath)) {
      // List what IS in the directory for debugging
      var dirFiles = [];
      try { dirFiles = fs.readdirSync(DOWNLOAD_DIR); } catch (e) {}
      throw new Error("No output file found. Files in dir: " + dirFiles.join(", "));
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
    }, 4 * 60 * 60 * 1000);

  } catch (error) {
    var errMsg = error.stderr
      ? error.stderr.slice(0, 500)
      : error.message || "Unknown error";

    console.error("[Download] Failed: " + assetId + " - " + errMsg);

    jobs.set(jobId, {
      status: "failed",
      assetId: assetId,
      error: errMsg,
      failedAt: Date.now()
    });

    var failExts = [".mp4", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".part", ".temp.mp4"];
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

async function downloadWithYtDlp(assetId, sourceUrl, startTrim, endTrim, maxDuration) {
  var outputTemplate = path.join(DOWNLOAD_DIR, assetId + ".%(ext)s");
  var expectedMp4 = path.join(DOWNLOAD_DIR, assetId + ".mp4");

  var args = [
    "-f", "bestvideo[height<=1080][vcodec^=avc]+bestaudio/best[height<=1080]/best",
    "--merge-output-format", "mp4",
    "--no-playlist",
    "--retries", "3",
    "--socket-timeout", "30",
    "--no-warnings",
    "-o", outputTemplate
  ];

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
    // yt-dlp might exit non-zero but still produce a file
    console.log("[yt-dlp] Process error (may still have output): " + (err.message || "").slice(0, 200));
    if (err.stderr) console.log("[yt-dlp] stderr: " + err.stderr.slice(0, 500));
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
          "-c:v", "libx264", "-preset", "fast", "-crf", "22",
          "-c:a", "aac", "-b:a", "192k",
          "-y", convertedPath
        ], { timeout: 120000 });
        fs.unlinkSync(found);
        return convertedPath;
      } catch (convertErr) {
        console.log("[yt-dlp] MP4 conversion failed, keeping original: " + convertErr.message);
        return found;
      }
    }

    return found;
  }

  return null;
}

var PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", function() {
  console.log("Download worker running on port " + PORT);
  console.log("Auth: " + (API_KEY ? "enabled" : "disabled (set API_KEY env var to enable)"));
});
