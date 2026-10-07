import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const execFileAsync = promisify(execFile);
const WORKER_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_TEST_KEY = "worker-test-key-only";
const REQUEST_TIMEOUT_MS = 150_000;

async function makeFixtureVideo(filePath) {
  await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=25:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-shortest",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    filePath,
  ], { timeout: 30_000 });
}

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForWorker(baseUrl, worker) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (worker.exitCode !== null) throw new Error("Worker exited before becoming healthy.");
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.json()).status === "ok") return;
    } catch {
      // The local worker is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local worker did not become healthy.");
}

async function waitForJob(url, headers, timeoutMs = REQUEST_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(url, { headers });
    const job = await response.json();
    if (job.status === "completed" || job.status === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Worker job did not finish before the test timeout.");
}

function jsonOptions(headers, body) {
  return {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

test("authenticated worker downloads a clip, renders it, and serves the MP4 and SRT", { timeout: 180_000 }, async (t) => {
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lore-worker-e2e-"));
  const downloadsDirectory = path.join(tempDirectory, "downloads");
  const pythonPath = path.join(tempDirectory, "python");
  const fakeWhisper = path.join(pythonPath, "faster_whisper");
  const fixturePath = path.join(tempDirectory, "fixture.mp4");
  await fs.promises.mkdir(downloadsDirectory, { recursive: true });
  await fs.promises.mkdir(fakeWhisper, { recursive: true });
  t.after(async () => fs.promises.rm(tempDirectory, { recursive: true, force: true }));

  await makeFixtureVideo(fixturePath);
  await fs.promises.writeFile(path.join(fakeWhisper, "__init__.py"), [
    "from types import SimpleNamespace",
    "class WhisperModel:",
    "    def __init__(self, *args, **kwargs): pass",
    "    def transcribe(self, *args, **kwargs):",
    "        words = [",
    "            SimpleNamespace(start=0.10, end=0.38, word='KAI'),",
    "            SimpleNamespace(start=0.48, end=0.82, word='ROASTED'),",
    "        ]",
    "        return [SimpleNamespace(words=words)], None",
    "",
  ].join("\n"));

  const assetServer = createServer((request, response) => {
    if (request.url !== "/fixture.mp4") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": String(fs.statSync(fixturePath).size),
    });
    fs.createReadStream(fixturePath).pipe(response);
  });
  assetServer.listen(0, "127.0.0.1");
  await once(assetServer, "listening");
  t.after(async () => new Promise((resolve) => assetServer.close(() => resolve())));

  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const worker = spawn(process.execPath, ["server.js"], {
    cwd: WORKER_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      API_KEY: LOCAL_TEST_KEY,
      PORT: String(port),
      DOWNLOAD_DIR: downloadsDirectory,
      WHISPER_MODEL: "fixture",
      PYTHONPATH: [pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
  });
  let workerLog = "";
  worker.stdout.on("data", (chunk) => { workerLog += chunk.toString(); });
  worker.stderr.on("data", (chunk) => { workerLog += chunk.toString(); });
  t.after(async () => {
    if (worker.exitCode === null) worker.kill("SIGTERM");
    await Promise.race([once(worker, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
  });

  await waitForWorker(baseUrl, worker);
  const authHeaders = { Authorization: `Bearer ${LOCAL_TEST_KEY}` };
  const unauthenticatedFiles = await fetch(`${baseUrl}/api/debug/files`);
  assert.equal(unauthenticatedFiles.status, 401);
  const authenticatedFiles = await fetch(`${baseUrl}/api/debug/files`, { headers: authHeaders });
  assert.equal(authenticatedFiles.status, 200);

  const downloadResponse = await fetch(`${baseUrl}/api/download`, jsonOptions(authHeaders, {
    assetId: "fixture-clip",
    sourceUrl: `http://127.0.0.1:${assetServer.address().port}/fixture.mp4`,
    maxDuration: 300,
  }));
  assert.equal(downloadResponse.status, 200, workerLog);
  const downloadRequest = await downloadResponse.json();
  const downloadJob = await waitForJob(`${baseUrl}/api/status/${downloadRequest.jobId}`, authHeaders);
  assert.equal(downloadJob.status, "completed", downloadJob.error || workerLog);
  assert.equal(downloadJob.filename, "fixture-clip.mp4");

  const processResponse = await fetch(`${baseUrl}/api/process`, jsonOptions(authHeaders, {
    jobId: "fixture-process",
    clipFilename: downloadJob.filename,
    headline: "KAI GETS ROASTED",
    highlightWords: ["ROASTED"],
    musicUrl: null,
    captionStyle: "word-by-word",
    musicVolumeDb: -15,
    outputAspectRatio: "9:16",
  }));
  const accepted = await processResponse.json();
  assert.equal(processResponse.status, 202, JSON.stringify(accepted));
  assert.equal(accepted.jobId, "fixture-process");
  const processed = await waitForJob(`${baseUrl}/api/process/status/fixture-process`, authHeaders);
  assert.equal(processed.status, "completed", processed.error || workerLog);
  assert.equal(processed.filename, "processed_fixture-process.mp4");
  assert.equal(processed.downloadUrl, "/api/file/processed_fixture-process.mp4");
  assert.equal(processed.srtPath, "/api/file/fixture-process.srt");

  const srtResponse = await fetch(`${baseUrl}${processed.srtPath}`, { headers: authHeaders });
  assert.equal(srtResponse.status, 200);
  const srt = await srtResponse.text();
  assert.match(srt, /KAI/);
  assert.match(srt, /ROASTED/);

  const outputResponse = await fetch(`${baseUrl}${processed.downloadUrl}`, { headers: authHeaders });
  assert.equal(outputResponse.status, 200);
  assert.match(outputResponse.headers.get("content-type") || "", /video\/mp4/);
  const outputBytes = Buffer.from(await outputResponse.arrayBuffer());
  assert.ok(outputBytes.length > 1000);
  const outputPath = path.join(tempDirectory, "rendered.mp4");
  await fs.promises.writeFile(outputPath, outputBytes);
  const probe = JSON.parse((await execFileAsync(process.env.FFPROBE_BIN || "ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height",
    "-of", "json",
    outputPath,
  ])).stdout);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  assert.deepEqual({ width: video.width, height: video.height }, { width: 1080, height: 1920 });
  assert.ok(probe.streams.some((stream) => stream.codec_type === "audio"));

  const missingJob = await fetch(`${baseUrl}/api/process/status/not-a-real-job`, { headers: authHeaders });
  assert.equal(missingJob.status, 404);
  assert.equal((await missingJob.json()).status, "failed");

  await fs.promises.writeFile(path.join(downloadsDirectory, "not-a-video.mp4"), "invalid video fixture");
  const failedResponse = await fetch(`${baseUrl}/api/process`, jsonOptions(authHeaders, {
    jobId: "fixture-failed",
    clipFilename: "not-a-video.mp4",
    headline: "INVALID VIDEO",
    highlightWords: [],
    musicUrl: null,
    captionStyle: "word-by-word",
    musicVolumeDb: -15,
    outputAspectRatio: "9:16",
  }));
  assert.equal(failedResponse.status, 202);
  const failed = await waitForJob(`${baseUrl}/api/process/status/fixture-failed`, authHeaders);
  assert.equal(failed.status, "failed");
  assert.ok(failed.error && failed.error.length > 10);
  assert.ok(!fs.existsSync(path.join(downloadsDirectory, "processed_fixture-failed.mp4")));
  assert.ok(!fs.existsSync(path.join(downloadsDirectory, "fixture-failed.srt")));
});

test("renderer mixes source audio with background music while preserving the vertical format", { timeout: 120_000 }, async (t) => {
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lore-worker-music-"));
  t.after(async () => fs.promises.rm(tempDirectory, { recursive: true, force: true }));
  const clipPath = path.join(tempDirectory, "source.mp4");
  const musicPath = path.join(tempDirectory, "background.wav");
  const outputPath = path.join(tempDirectory, "mixed.mp4");
  await makeFixtureVideo(clipPath);
  await execFileAsync(process.env.FFMPEG_BIN || "ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=220:duration=2",
    "-c:a", "pcm_s16le",
    musicPath,
  ], { timeout: 30_000 });

  const { processVideo } = await import("./video-processor.js");
  const result = await processVideo({
    jobId: "fixture-music-mix",
    clipPath,
    outputPath,
    headline: "MUSIC MIX TEST",
    highlightWords: ["MIX"],
    musicFilePath: musicPath,
    musicVolumeDb: -15,
    transcribeWords: async () => [
      { start: 0.15, end: 0.45, text: "MUSIC" },
      { start: 0.55, end: 0.9, text: "MIX" },
    ],
  });

  assert.equal(result.captionWordCount, 2);
  assert.equal(path.basename(result.srtPath), "fixture-music-mix.srt");
  const probe = JSON.parse((await execFileAsync(process.env.FFPROBE_BIN || "ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,width,height",
    "-of", "json",
    outputPath,
  ])).stdout);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  assert.deepEqual({ width: video.width, height: video.height }, { width: 1080, height: 1920 });
  assert.ok(probe.streams.some((stream) => stream.codec_type === "audio"));
});

test("style presets: renders every preset, honours overrides, and returns cached-word-compatible output", { timeout: 240_000 }, async (t) => {
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "lore-worker-style-"));
  t.after(async () => fs.promises.rm(tempDirectory, { recursive: true, force: true }));
  const clipPath = path.join(tempDirectory, "source.mp4");
  await makeFixtureVideo(clipPath);
  const { processVideo, previewFrame } = await import("./video-processor.js");
  const words = [
    { word: "KAI", start: 0.1, end: 0.4 },
    { word: "GOT", start: 0.5, end: 0.8 },
    { word: "ROASTED", start: 0.9, end: 1.5 },
  ];

  for (const presetId of ["boxed_red", "glow_magenta", "cyan_pop"]) {
    const outputPath = path.join(tempDirectory, `${presetId}.mp4`);
    const result = await processVideo({
      jobId: `style-${presetId}`,
      clipPath,
      outputPath,
      headline: "Kai gets roasted by chat",
      highlightWords: ["Kai", "roasted"],
      stylePresetId: presetId,
      styleOverrides: { headline: { yPct: 30 }, caption: { highlightColor: "#FFE600" } },
      words,
    });
    assert.equal(result.captionWordCount, 3);
    assert.equal(result.words.length, 3, "cached words are returned for restyles");
    const probe = JSON.parse((await execFileAsync(process.env.FFPROBE_BIN || "ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "json", outputPath,
    ])).stdout);
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    assert.deepEqual({ width: video.width, height: video.height }, { width: 1080, height: 1920 });
  }

  const pngPath = path.join(tempDirectory, "preview.png");
  await previewFrame({
    clipPath: null, outputPath: pngPath, workDir: path.join(tempDirectory, "pv"),
    headline: "No Clover!", highlightWords: ["Clover"], stylePresetId: "glow_magenta", styleOverrides: {}, at: 0,
  });
  const png = await fs.promises.readFile(pngPath);
  assert.equal(png.subarray(1, 4).toString(), "PNG");

  await assert.rejects(
    processVideo({ jobId: "bad-db", clipPath, outputPath: path.join(tempDirectory, "bad.mp4"), headline: "X", highlightWords: [], musicVolumeDb: 5, words }),
    /Music volume/,
  );
});
