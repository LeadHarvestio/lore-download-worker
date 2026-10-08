import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { downloadErrorMessage } from "./errors.js";

const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = source.indexOf("async function downloadWithYtDlp(");
const end = source.indexOf("\nvar PORT =", start);
assert.ok(start >= 0 && end > start, "Find the actual worker downloader, not a test approximation.");
function downloader({ execute, exists = false }) {
  return vm.runInNewContext("(" + source.slice(start, end).trim() + ")", {
    path, DOWNLOAD_DIR: "/tmp/test-downloads", console: { log() {} },
    fs: { existsSync: () => exists }, findOutputFile: () => null,
    resolveTikTokVideoUrl: async () => "https://www.tiktok.com/@creator/video/123",
    execFileAsync: execute, downloadErrorMessage,
  });
}
test("worker passes the resolved full TikTok URL to the extractor", async () => {
  let passed;
  const run = downloader({ exists: true, execute: async (_binary, args) => { passed = args; return { stdout: "" }; } });
  assert.equal(await run("test", "https://tiktok.com/t/ABC"), "/tmp/test-downloads/test.mp4");
  assert.equal(passed.at(-1), "https://www.tiktok.com/@creator/video/123");
});
test("extractor failures surface useful errors and never accept partial output", async () => {
  const run = downloader({ exists: true, execute: async () => { throw { code: 1, stderr: "ERROR: [TikTok] Unexpected response from webpage request https://example.com/private?token=secret" }; } });
  await assert.rejects(run("test", "https://tiktok.com/t/ABC"), error => {
    assert.match(error.message, /Unexpected response/);
    assert.doesNotMatch(error.message, /secret|Files in dir/);
    return true;
  });
});
test("a successful command without footage never dumps unrelated files", async () => {
  const run = downloader({ execute: async () => ({ stdout: "" }) });
  await assert.rejects(run("test", "https://tiktok.com/t/ABC"), /no playable video file was produced/);
});
