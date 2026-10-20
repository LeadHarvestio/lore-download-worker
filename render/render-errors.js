/** Describe child-process failures without leaking signed URLs/command lines. */
export function renderFailureDetail(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  if (stderr) return stderr;
  if (error?.signal === "SIGKILL") return "FFmpeg was killed (SIGKILL), usually because the worker ran out of memory. Your edit is preserved.";
  if (error?.code === "ABORT_ERR" || error?.name === "AbortError") return "FFmpeg exceeded the render deadline or was cancelled. Your edit is preserved.";
  if (error?.killed || error?.code === "ETIMEDOUT") return "FFmpeg exceeded its processing time limit. Your edit is preserved.";
  if (typeof error?.code === "number") return `FFmpeg exited with code ${error.code} without diagnostic output. Your edit is preserved.`;
  return error?.message || "Unknown FFmpeg error.";
}
