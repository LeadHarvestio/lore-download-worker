import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("./analyze-faces.py", import.meta.url));
export function createFaceAnalysisQueue(directory, isRendererBusy, onIdle = () => {}) {
  const jobs = new Map(), identities = new Map(), queue = [];
  let active = false, timer;
  const retention = 24 * 60 * 60 * 1000;
  const cacheDir = path.join(directory, ".face-analysis");
  fs.mkdirSync(cacheDir, { recursive: true });
  function pump() {
    if (active || !queue.length) return;
    if (isRendererBusy()) { clearTimeout(timer); timer = setTimeout(pump, 1000); timer.unref(); return; }
    const item = queue.shift(), job = jobs.get(item.jobId);
    active = true; job.status = "processing"; job.startedAt = Date.now();
    execFile(process.env.PYTHON_BIN || "python3", [script, item.file], {
      timeout: 60000, maxBuffer: 3 * 1024 * 1024,
      env: { ...process.env, OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" },
    }, (error, stdout) => {
      try {
        if (error) throw Error("Face analysis failed or exceeded its active-time budget. Retry when the worker is idle.");
        const result = JSON.parse(stdout);
        if (!Array.isArray(result.tracks)) throw Error("Face detector returned invalid data.");
        job.status = "completed"; job.result = result;
        fs.writeFileSync(item.cache, JSON.stringify({ savedAt: Date.now(), result }));
      } catch (failure) { job.status = "failed"; job.error = failure.message; identities.delete(item.identity); }
      job.finishedAt = Date.now(); active = false; onIdle(); pump();
    });
  }
  return {
    get active() { return active; },
    get(jobId) {
      const job = jobs.get(jobId);
      if (!job) return null;
      const position = queue.findIndex(item => item.jobId === jobId);
      return { ...job, queuePosition: position < 0 ? null : position + 1 };
    },
    enqueue(filename, force = false) {
      if (typeof filename !== "string" || !/^[A-Za-z0-9_.-]+\.mp4$/i.test(filename) || filename.includes("..")) throw Error("Invalid source filename.");
      const file = path.join(directory, filename), stat = fs.statSync(file);
      for (const entry of fs.readdirSync(cacheDir)) {
        const cached = path.join(cacheDir, entry);
        if (/^[a-f0-9]{64}\.json$/.test(entry) && Date.now() - fs.statSync(cached).mtimeMs > retention) fs.unlinkSync(cached);
      }
      const identity = crypto.createHash("sha256").update(JSON.stringify([filename, stat.size, stat.mtimeMs, "yunet-2023mar-v1"])).digest("hex");
      const previous = identities.get(identity);
      if (previous && jobs.has(previous) && (!force || ["queued", "processing"].includes(jobs.get(previous).status))) return jobs.get(previous);
      for (const [id, job] of jobs) if (Date.now() - (job.finishedAt || job.queuedAt) > retention) jobs.delete(id);
      const jobId = crypto.randomUUID(), cache = path.join(cacheDir, `${identity}.json`);
      const job = { jobId, status: "queued", queuedAt: Date.now() };
      try {
        const saved = JSON.parse(fs.readFileSync(cache, "utf8"));
        if (!force && Date.now() - saved.savedAt < retention) Object.assign(job, { status: "completed", result: saved.result, cached: true, finishedAt: Date.now() });
      } catch {}
      jobs.set(jobId, job); identities.set(identity, jobId);
      if (job.status !== "completed") { queue.push({ jobId, file, identity, cache }); pump(); }
      return job;
    },
  };
}
