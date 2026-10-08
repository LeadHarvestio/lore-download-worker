import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export function fileFingerprint(file) {
  const stat = fs.statSync(file);
  return `${path.resolve(file)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

export async function contentFingerprint(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function createRenderCache({ directory = process.env.RENDER_CACHE_DIR || path.join(os.tmpdir(), "clip-render-cache"), maxBytes = 512 * 1024 * 1024, ttlMs = 4 * 60 * 60 * 1000 } = {}) {
  const pending = new Map(), leases = new Map();
  fs.mkdirSync(directory, { recursive: true });
  function prune() {
    const now = Date.now();
    const files = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.(mp4|wav)$/.test(name)).map(name => {
      const file = path.join(directory, name);
      const stat = fs.statSync(file);
      return { file, bytes: stat.size, used: stat.mtimeMs };
    }).sort((a, b) => a.used - b.used);
    let total = files.reduce((n, f) => n + f.bytes, 0);
    for (const item of files) {
      if (leases.has(item.file)) continue;
      if (now - item.used <= ttlMs && total <= maxBytes) continue;
      fs.unlinkSync(item.file); total -= item.bytes;
    }
  }
  return {
    async acquire(namespace, key, extension, produce) {
      if (!["mp4", "wav"].includes(extension)) throw new Error("Invalid render cache format.");
      const digest = crypto.createHash("sha256").update(namespace + ":" + JSON.stringify(key)).digest("hex");
      const file = path.join(directory, digest + "." + extension);
      const hit = fs.existsSync(file);
      if (!hit) {
        if (!pending.has(file)) {
          const temp = path.join(directory, digest + "." + crypto.randomUUID() + ".part." + extension);
          const work = Promise.resolve().then(() => produce(temp)).then(() => {
            if (!fs.statSync(temp).size) throw new Error("Render cache producer wrote an empty file.");
            fs.renameSync(temp, file);
          }).finally(() => {
            pending.delete(file);
            fs.rmSync(temp, { force: true });
          });
          pending.set(file, work);
        }
        await pending.get(file);
      }
      leases.set(file, (leases.get(file) || 0) + 1);
      fs.utimesSync(file, new Date(), new Date());
      prune();
      let released = false;
      return { file, hit, release() {
        if (released) return;
        released = true;
        const count = (leases.get(file) || 1) - 1;
        if (count) leases.set(file, count); else leases.delete(file);
        prune();
      } };
    },
  };
}
