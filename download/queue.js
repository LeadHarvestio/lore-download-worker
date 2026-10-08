export function createDownloadQueue({ run, onStart, onError, concurrency = 2 }) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid download concurrency.");
  const pending = [];
  let active = 0;
  function drain() {
    while (active < concurrency && pending.length) {
      const task = pending.shift();
      active++;
      Promise.resolve().then(() => {
        onStart(task.id);
        return run(task.id, task.params);
      }).catch((error) => onError(task.id, error)).finally(() => {
        active--;
        drain();
      });
    }
  }
  return {
    enqueue(id, params) { pending.push({ id, params }); drain(); },
    position(id) { const index = pending.findIndex((task) => task.id === id); return index < 0 ? null : index + 1; },
    get active() { return active; },
    get waiting() { return pending.length; },
  };
}
