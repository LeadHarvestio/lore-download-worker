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
function downloader({ execute, exists = false, resolve = async () => "https://www.tiktok.com/@creator/video/123" }) {
  return vm.runInNewContext("(" + source.slice(start, end).trim() + ")", {
    path, URL, DOWNLOAD_DIR: "/tmp/test-downloads", console: { log() {} },
    fs: { existsSync: () => exists }, findOutputFile: () => null,
    resolveTikTokVideoUrl: resolve,
    execFileAsync: execute, downloadErrorMessage,
  });
}
test("worker passes the resolved full TikTok URL to the extractor", async () => {
  let passed;
  const run = downloader({ exists: true, execute: async (_binary, args) => { passed = args; return { stdout: "" }; } });
  assert.equal(await run("test", "https://tiktok.com/t/ABC"), "/tmp/test-downloads/test.mp4");
  assert.equal(passed.at(-1), "https://www.tiktok.com/@creator/video/123");
  assert.equal(passed[passed.indexOf("--impersonate") + 1], "chrome");
  assert.match(passed[passed.indexOf("--user-agent") + 1], /Chrome\/140/);
});
test("non-TikTok downloads keep their existing request profile", async () => {
  let passed;
  const run = downloader({ exists: true, resolve: async value => value, execute: async (_binary, args) => { passed = args; return { stdout: "" }; } });
  await run("test", "https://x.com/creator/status/123");
  assert.equal(passed.includes("--impersonate"), false);
  assert.equal(passed.includes("--user-agent"), false);
});
test("generic extractor query identifiers do not leak playback signatures", () => {
  const message = downloadErrorMessage({ stderr: "ERROR: [generic] ?signature=secret&expire=123: HTTP Error 403: Forbidden" });
  assert.match(message, /403/);
  assert.doesNotMatch(message, /signature|secret|expire=123/);
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
