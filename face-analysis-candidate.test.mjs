import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFaceAnalysisQueue } from "./render/face-analysis.js";

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "face-queue-"));
  fs.writeFileSync(path.join(directory, "source.mp4"), "fixture");
  const calls = [], pending = [];
  const execute = (command, args, opts, callback) => {
    calls.push({ command, args, opts });
    pending.push({ args, callback });
  };
  const queue = createFaceAnalysisQueue(directory, () => false, () => {}, { execute, ...options });
  return { directory, calls, pending, queue,
    done(result = { tracks: [] }, error = null, stderr = "") {
      const next = pending.shift();
      const evidence = next.args[3];
      if (evidence && !error) fs.writeFileSync(evidence, "evidence");
      next.callback(error, JSON.stringify(result), stderr);
    },
    close() { fs.rmSync(directory, { recursive: true, force: true }); },
  };
}
const candidateResult = { tracks: [], evidence: { version: "local-motion-keyframe-v3", sampleFps: 10 } };

test("default remains legacy, candidate is explicit and cache namespaces differ", () => {
  const f = fixture({ candidate: false });
  try {
    f.queue.enqueue("source.mp4");
    assert.match(f.calls[0].args[0], /\/analyze-faces\.py$/);
    assert.equal(f.calls[0].args.length, 2);
    f.done();
    const g = fixture({ candidate: true });
    try {
      // Copy a legacy disk entry to the candidate directory; it must not hit it.
      for (const entry of fs.readdirSync(path.join(f.directory, ".face-analysis")))
        fs.copyFileSync(path.join(f.directory, ".face-analysis", entry), path.join(g.directory, ".face-analysis", entry));
      const job = g.queue.enqueue("source.mp4");
      assert.equal(job.status, "processing");
      assert.match(g.calls[0].args[0], /\/analyze-faces-candidate\.py$/);
      assert.equal(g.calls[0].args[2], "--evidence");
      g.done(candidateResult);
      assert.equal(job.status, "completed");
    } finally { g.close(); }
  } finally { f.close(); }
});
test("single flight includes force; candidate evidence survives queue recreation", () => {
  const f = fixture({ candidate: true });
  try {
    const job = f.queue.enqueue("source.mp4");
    assert.equal(f.queue.enqueue("source.mp4", true).jobId, job.jobId);
    assert.equal(f.calls.length, 1);
    f.done(candidateResult);
    assert.ok(f.queue.evidence(job.jobId));
    const restored = createFaceAnalysisQueue(f.directory, () => false, () => {}, {
      candidate: true, execute() { throw Error("Must use disk cache"); },
    });
    const saved = restored.enqueue("source.mp4");
    assert.equal(saved.status, "completed");
    assert.ok(saved.cached);
    assert.ok(restored.evidence(saved.jobId));
    // Dense data must not grow the recipe/API result.
    assert.equal(JSON.stringify(saved.result).includes("evidence"), true);
    assert.equal(saved.result.evidence.frames, undefined);
  } finally { f.close(); }
});
test("missing sidecar never masquerades as a completed dense analysis", () => {
  const f = fixture({ candidate: true });
  try {
    f.queue.enqueue("source.mp4"); f.done(candidateResult);
    for (const name of fs.readdirSync(path.join(f.directory, ".face-analysis")))
      if (name.endsWith(".gz")) fs.unlinkSync(path.join(f.directory, ".face-analysis", name));
    let called = false;
    const restored = createFaceAnalysisQueue(f.directory, () => false, () => {}, {
      candidate: true, execute() { called = true; },
    });
    assert.equal(restored.enqueue("source.mp4").status, "processing");
    assert.ok(called);
  } finally { f.close(); }
});
test("analysis limitation fails explicitly, clears active state and can retry", () => {
  const f = fixture({ candidate: true });
  try {
    const job = f.queue.enqueue("source.mp4");
    f.done(null, Error("timeout"), "Face analysis exceeded its 55-second active budget. No partial result was accepted.");
    assert.equal(job.status, "failed");
    assert.match(job.error, /55-second/);
    assert.equal(f.queue.active, false);
    assert.notEqual(f.queue.enqueue("source.mp4").jobId, job.jobId);
    assert.equal(f.calls.length, 2);
  } finally { f.close(); }
});
test("invalid candidate output and source traversal fail closed", () => {
  const f = fixture({ candidate: true });
  try {
    assert.throws(() => f.queue.enqueue("../source.mp4"), /filename/);
    const job = f.queue.enqueue("source.mp4");
    f.done({ tracks: [], evidence: { version: "older" } });
    assert.equal(job.status, "failed");
    assert.equal(f.queue.evidence(job.jobId), null);
  } finally { f.close(); }
});
