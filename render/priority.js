// Re-edits take precedence over a waiting batch, but five-minute-old jobs
// gain priority to keep repeated interactive edits from starving the batch.
export function orderRenderJobs(ids, jobs, now = Date.now()) {
  const rank = job => now - job.queuedAt >= 5 * 60 * 1000 ? 2 : job.priority === "interactive" ? 1 : 0;
  return [...ids].sort((a, b) => rank(jobs.get(b)) - rank(jobs.get(a)));
}
