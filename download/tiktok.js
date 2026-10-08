function isTikTok(url) {
  return url.protocol === "https:" && !url.username && !url.password &&
    (!url.port || url.port === "443") &&
    ["tiktok.com", "www.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"].includes(url.hostname);
}

export async function resolveTikTokVideoUrl(sourceUrl, request = fetch) {
  let url;
  try { url = new URL(sourceUrl); } catch { return sourceUrl; }
  if (!isTikTok(url)) return sourceUrl;
  for (let hop = 0; hop < 6; hop++) {
    const match = url.pathname.match(/^\/@([^/]+)\/video\/(\d+)\/?$/);
    if (match) return `https://www.tiktok.com/@${match[1]}/video/${match[2]}`;
    // Resolve only share links, never profiles, login pages or arbitrary destinations.
    if (!/^\/t\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) &&
        !["vm.tiktok.com", "vt.tiktok.com"].includes(url.hostname)) {
      throw new Error("TikTok share link did not resolve to a video. Try its full @creator/video link.");
    }
    const response = await request(url.href, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(15000) });
    if (response.status === 429) throw new Error("TikTok rate limited this share-link request. Wait before retrying.");
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      throw new Error(`TikTok share link could not be resolved (HTTP ${response.status}). Try its full @creator/video link.`);
    }
    const next = new URL(location, url);
    if (!isTikTok(next)) throw new Error("TikTok share link redirected outside the allowed TikTok hosts.");
    url = next;
  }
  throw new Error("TikTok share link redirected too many times. Try its full @creator/video link.");
}
