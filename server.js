import express from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || "";
const DOWNLOAD_DIR = "/tmp/downloads";
const jobs = new Map();

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function auth(req, res, next) {
  if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/", (_req, res) => {
  res.json({
    service: "lore-download-worker",
    status: "running",
    jobs: jobs.size,
    uptime: Math.round(process.uptime()),
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/download", auth, (req, res) => {
  const { assetId, sourceUrl, platform, startTrim, endTrim, maxDuration } = req.body;

  if (!sourceUrl) {
    return res.status(400).json({ error: "sourceUrl is required" });
  }

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: "downloading", assetId, sourceUrl, startedAt: Date.now() });

  res.json({ jobId, status: "downloading" });

  processDownload(jobId, {
    assetId: assetId || jobId,
    sourceUrl,
    startTrim,
    endTrim,
    maxDuration: maxDuration || 300,
  });
});

app.get("/api/status/:jobId", auth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  res.json(job);
});

app.get("/api/file/:filename", auth, (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, "");
  const filePath = path.join(DOWNLOAD_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  res.sendFile(filePath);
});

app.get("/api/jobs", auth, (_req, res) => {
  const allJobs = [];
  for (const [id, job] of jobs.entries()) {
    allJobs.push({ jobId: id, ...job });
  }
  res.json(allJobs);
});

async function processDownload(jobId, { assetId, sourceUrl, startTrim, endTrim, maxDuration }) {
  const outputPath = path.join(DOWNLOAD_DIR, `${assetId}.mp4`);

  try {
    console.log(`[Download] Starting: ${assetId} - ${sourceUrl}`);

    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }

    const args = [
      "-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
      "--merge-output-format", "mp4",
      "--no-playlist",
      "--retries", "3",
      "--socket-timeout", "30",
      "--no-warnings",
      "-o", outputPath,
    ];

    if (startTrim !== undefined && endTrim !== undefined && endTrim > startTrim) {
      args.push("--download-sections", `*${startTrim}-${endTrim}`);
      args.push("--force-keyframes-at-cuts");
    } else if (maxDuration && maxDuration < 600) {
      args.push("--download-sections", `*0-${maxDuration}`);
      args.push("--force-keyframes-at-cuts");
    }

    args.push(sourceUrl);

    await execFileAsync("yt-dlp", args, {
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error("yt-dlp completed but no output file was created");
    }

    const stats = fs.statSync(outputPath);

    let duration = 0;
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "quiet",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        outputPath,
      ]);
      duration = parseFloat(stdout.trim()) || 0;
    } catch {}

    const filename = `${assetId}.mp4`;

    jobs.set(jobId, {
      status: "completed",
      assetId,
      downloadUrl: `/api/file/${filename}`,
      filename,
      fileSizeBytes: stats.size,
      durationSeconds: duration,
      completedAt: Date.now(),
    });

    console.log(`[Download] Complete: ${assetId} - ${(stats.size / 1024 / 1024).toFixed(1)}MB, ${duration.toFixed(1)}s`);

    setTimeout(() => {
      try {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      } catch {}
      jobs.delete(jobId);
    }, 2 * 60 * 60 * 1000);

  } catch (error) {
    const errMsg = error.stderr
      ? error.stderr.slice(0, 500)
      : error.message || "Unknown error";

    console.error(`[Download] Failed: ${assetId} - ${errMsg}`);

    jobs.set(jobId, {
      status: "failed",
      assetId,
      error: errMsg,
      failedAt: Date.now(),
    });

    if (fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath); } catch {}
    }

    setTimeout(() => { jobs.delete(jobId); }, 60 * 60 * 1000);
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Download worker running on port ${PORT}`);
  console.log(`Auth: ${API_KEY ? "enabled" : "disabled (set API_KEY env var to enable)"}`);
});
