import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

// Candidate is explicitly staging-only until the reviewed identity gate passes.
// Never silently replace the current production tracker or change saved IDs.
const version = "local-motion-sface-v2";
export function createFaceAnalysisQueue(directory, isRendererBusy, onIdle = () => {}, options = {}) {
  const candidate = options.candidate ?? process.env.FACE_ANALYSIS_CANDIDATE === "1";
  const script = fileURLToPath(new URL(candidate ? "./analyze-faces-candidate.py" : "./analyze-faces.py", import.meta.url));
  const execute = options.execute || execFile;
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
    execute(process.env.PYTHON_BIN || "python3", [script, item.file, ...(candidate ? ["--evidence", item.evidence] : [])], {
      timeout: 60000, maxBuffer: 3 * 1024 * 1024,
      env: { ...process.env, OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" },
    }, (error, stdout, stderr) => {
      try {
        // Preserve explicit bounded-source/rate failures, not raw arbitrary stderr.
        if (error) {
          const limitation = String(stderr || "").match(/(?:Dense face analysis supports sources up to 180 seconds\. Split longer sources before analysis\.|Source frame rate is below the required 10 fps evidence rate\.|Face analysis exceeded its 55-second active budget\. No partial result was accepted\.)/);
          throw Error(limitation?.[0] || "Face analysis failed or exceeded its active-time budget. Retry when the worker is idle.");
        }
        const result = JSON.parse(stdout);
        if (!Array.isArray(result.tracks)) throw Error("Face detector returned invalid data.");
        if (candidate && (result.evidence?.version !== version || !fs.existsSync(item.evidence)))
          throw Error("Dense identity evidence was not saved; no candidate result was accepted.");
        fs.writeFileSync(item.cache + ".tmp", JSON.stringify({ savedAt: Date.now(), result }));
        fs.renameSync(item.cache + ".tmp", item.cache);
        job.status = "completed"; job.result = result;
      } catch (failure) {
        job.status = "failed"; job.error = failure.message; identities.delete(item.identity);
        for (const file of [item.evidence, item.evidence + ".tmp", item.cache + ".tmp"])
          try { fs.unlinkSync(file); } catch {}
      }
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
    // Local queue API for the future authenticated speech-to-face service.
    // No embeddings/images in this gzip: timed boxes/landmarks + scene markers.
    evidence(jobId) {
      const job = jobs.get(jobId), identity = job && [...identities].find(([, id]) => id === jobId)?.[0];
      if (!candidate || job?.status !== "completed" || !identity) return null;
      const file = path.join(cacheDir, `${identity}.evidence.json.gz`);
      return fs.existsSync(file) ? fs.readFileSync(file) : null;
    },
    enqueue(filename, force = false) {
      if (typeof filename !== "string" || !/^[A-Za-z0-9_.-]+\.mp4$/i.test(filename) || filename.includes("..")) throw Error("Invalid source filename.");
      const file = path.join(directory, filename), stat = fs.statSync(file);
      const activeIdentities = new Set([...identities].filter(([, id]) =>
        ["queued", "processing"].includes(jobs.get(id)?.status)).map(([key]) => key));
      for (const entry of fs.readdirSync(cacheDir)) {
        if (!/^[a-f0-9]{64}\.(json|evidence\.json\.gz)(\.tmp)?$/.test(entry) || activeIdentities.has(entry.slice(0, 64))) continue;
        const cached = path.join(cacheDir, entry);
        if (Date.now() - fs.statSync(cached).mtimeMs > retention) fs.unlinkSync(cached);
      }
      const identity = crypto.createHash("sha256").update(JSON.stringify([
        filename, stat.size, stat.mtimeMs, candidate ? version : "yunet-2023mar-v1",
      ])).digest("hex");
      const previous = identities.get(identity);
      const prior = jobs.get(previous);
      if (prior && (["queued", "processing"].includes(prior.status) ||
          !force && prior.status === "completed" && (!candidate ||
            fs.existsSync(path.join(cacheDir, `${identity}.evidence.json.gz`))))) return prior;
      for (const [id, job] of jobs) if (Date.now() - (job.finishedAt || job.queuedAt) > retention) jobs.delete(id);
      const jobId = crypto.randomUUID(), cache = path.join(cacheDir, `${identity}.json`);
      const evidence = path.join(cacheDir, `${identity}.evidence.json.gz`);
      const job = { jobId, status: "queued", queuedAt: Date.now() };
      try {
        const saved = JSON.parse(fs.readFileSync(cache, "utf8"));
        if (!force && Date.now() - saved.savedAt < retention &&
            (!candidate || saved.result.evidence?.version === version && fs.existsSync(evidence)))
          Object.assign(job, { status: "completed", result: saved.result, cached: true, finishedAt: Date.now() });
      } catch {}
      jobs.set(jobId, job); identities.set(identity, jobId);
      if (job.status !== "completed") { queue.push({ jobId, file, identity, cache, evidence }); pump(); }
      return job;
    },
  };
}
