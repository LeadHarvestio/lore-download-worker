import { test } from "node:test";
import assert from "node:assert/strict";
import { createDownloadQueue } from "./queue.js";
import { downloadErrorMessage } from "./errors.js";
import { resolveTikTokVideoUrl } from "./tiktok.js";

test("twenty queued downloads use at most two slots, preserve order, and survive a failure", async () => {
  const started = [], failed = [], completed = [];
  let active = 0, maximum = 0;
  const queue = createDownloadQueue({
    onStart: (id) => started.push(id), onError: (id) => failed.push(id),
    run: async (id) => {
      active++; maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (id === 3) throw new Error("bad source");
        completed.push(id);
      } finally { active--; }
    },
  });
  for (let id = 0; id < 20; id++) queue.enqueue(id, {});
  assert.equal(queue.waiting, 18);
  assert.equal(queue.position(2), 1);
  while (queue.active || queue.waiting) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(maximum, 2);
  assert.deepEqual(started, Array.from({ length: 20 }, (_, i) => i));
  assert.deepEqual(failed, [3]);
  assert.equal(completed.length, 19);
});

test("diagnostics keep the useful error instead of FFmpeg's opening chatter, and redact signed URLs", () => {
  const error = { stderr: "[hls] Opening fragment\nERROR: unable to create thread: Resource temporarily unavailable https://cdn.test/v?secret=private\n", code: 1 };
  const message = downloadErrorMessage(error);
  assert.match(message, /unable to create thread/);
  assert.match(message, /exited with code 1/);
  assert.doesNotMatch(message, /secret|private|Opening/);
  assert.match(downloadErrorMessage({ killed: true, signal: "SIGTERM", message: "Command timed out" }), /SIGTERM/);
  assert.match(downloadErrorMessage({ stderr: "ERROR: [TikTok] Unexpected response from webpage request" }), /\[TikTok\].*Unexpected response/);
});

test("TikTok redirects become clean canonical full video URLs", async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push(url); assert.equal(options.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://www.tiktok.com/@creator/video/12345?tracking=remove" } });
  };
  assert.equal(await resolveTikTokVideoUrl("https://tiktok.com/t/Short", request), "https://www.tiktok.com/@creator/video/12345");
  assert.equal(calls.length, 1);
  assert.equal(await resolveTikTokVideoUrl("https://tiktok.com/@creator/video/12345?tracking=remove", request), "https://www.tiktok.com/@creator/video/12345");
  assert.equal(calls.length, 1);
  assert.equal(await resolveTikTokVideoUrl("https://x.com/user/status/123", request), "https://x.com/user/status/123");
});

test("TikTok redirect guards reject private/external destinations, rate limits and loops", async () => {
  await assert.rejects(resolveTikTokVideoUrl("https://tiktok.com/t/Short", async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } })), /allowed TikTok hosts/);
  await assert.rejects(resolveTikTokVideoUrl("https://tiktok.com/t/Short", async () => new Response(null, { status: 429 })), /rate limited/);
  await assert.rejects(resolveTikTokVideoUrl("https://tiktok.com/t/Short", async () => new Response(null, { status: 302, headers: { location: "/t/Short" } })), /too many times/);
  await assert.rejects(resolveTikTokVideoUrl("https://tiktok.com/t/Short", async () => new Response(null, { status: 302, headers: { location: "/login" } })), /did not resolve to a video/);
});
