export function downloadErrorMessage(error) {
  const stderr = String(error?.stderr || "").trim();
  const lines = stderr.split(/\r?\n/).filter(Boolean);
  const useful = lines.filter((line) => /error|failed|unexpected|unsupported|unable|invalid|denied|unavailable|timeout|resource|memory|429|403|404/i.test(line));
  const detail = (useful.length ? useful.slice(-8) : lines.slice(-6)).join("\n") || String(error?.message || "Download failed.");
  const termination = error?.killed ? `Downloader was terminated${error.signal ? ` (${error.signal})` : ""}. ` : "";
  const exit = typeof error?.code === "number" ? `Downloader exited with code ${error.code}. ` : "";
  return termination + exit + detail
    .replace(/https?:\/\/[^\s"'<>]+/g, "[source URL]")
    .replace(/\?[^\s"'<>]+/g, "[source query]")
    .slice(-1500);
}
