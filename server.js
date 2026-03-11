async function processDownload(jobId, { assetId, sourceUrl, startTrim, endTrim, maxDuration }) {
  const baseOutput = path.join(DOWNLOAD_DIR, assetId);

  try {
    console.log(`[Download] Starting: ${assetId} - ${sourceUrl}`);

    // Clean up any previous attempts
    for (const ext of [".mp4", ".jpg", ".jpeg", ".png", ".webp", ".gif"]) {
      const p = baseOutput + ext;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    // Detect if this is a direct image URL (not a video platform)
    const urlLower = sourceUrl.toLowerCase().split("?")[0];
    const imageExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"];
    const isDirectImage = imageExtensions.some(ext => urlLower.endsWith(ext));

    let outputPath;
    let isImage = false;

    if (isDirectImage) {
      // Direct image download — no yt-dlp needed
      console.log(`[Download] Detected image URL, downloading directly: ${assetId}`);
      outputPath = await downloadDirectFile(assetId, sourceUrl);
      isImage = true;
    } else {
      // Video platform — use yt-dlp
      outputPath = await downloadWithYtDlp(assetId, sourceUrl, startTrim, endTrim, maxDuration);
    }

    if (!outputPath || !fs.existsSync(outputPath)) {
      throw new Error("Download completed but no output file was created");
    }

    const stats = fs.statSync(outputPath);
    const filename = path.basename(outputPath);

    let duration = 0;
    if (!isImage) {
      try {
        const { stdout } = await execFileAsync("ffprobe", [
          "-v", "quiet",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          outputPath,
        ]);
        duration = parseFloat(stdout.trim()) || 0;
      } catch {}
    }

    jobs.set(jobId, {
      status: "completed",
      assetId,
      downloadUrl: `/api/file/${filename}`,
      filename,
      fileSizeBytes: stats.size,
      durationSeconds: duration,
      isImage,
      completedAt: Date.now(),
    });

    console.log(`[Download] Complete: ${assetId} - ${filename} (${(stats.size / 1024 / 1024).toFixed(1)}MB${duration ? `, ${duration.toFixed(1)}s` : ""})`);

    setTimeout(() => {
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
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

    // Clean up partial files
    for (const ext of [".mp4", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".part"]) {
      const p = baseOutput + ext;
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch {} }
    }

    setTimeout(() => { jobs.delete(jobId); }, 60 * 60 * 1000);
  }
}

async function downloadDirectFile(assetId, sourceUrl) {
  const urlPath = new URL(sourceUrl).pathname.toLowerCase();
  let ext = ".jpg";
  if (urlPath.endsWith(".png")) ext = ".png";
  else if (urlPath.endsWith(".webp")) ext = ".webp";
  else if (urlPath.endsWith(".gif")) ext = ".gif";
  else if (urlPath.endsWith(".jpeg")) ext = ".jpeg";

  const outputPath = path.join(DOWNLOAD_DIR, `${assetId}${ext}`);

  const response = await fetch(sourceUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "image/*,*/*",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);

  return outputPath;
}

async function downloadWithYtDlp(assetId, sourceUrl, startTrim, endTrim, maxDuration) {
  const outputPath = path.join(DOWNLOAD_DIR, `${assetId}.mp4`);

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
    throw new Error("yt-dlp
