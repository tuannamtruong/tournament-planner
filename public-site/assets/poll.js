// Poll data/version.json every 15s; refetch the named view file when the
// timestamp changes. Errors are swallowed (offline = stale data, not a broken
// page). Both URLs are relative so the same code works from S3 or localhost.

const POLL_MS = 15_000;
const updatedEl = () => document.getElementById('updated');

export function startPolling(viewFile, onData) {
  let lastVersion = null;

  async function tick() {
    try {
      const v = await fetch(`data/version.json?t=${Date.now()}`, { cache: 'no-cache' }).then(r => r.json());
      const stamp = v.updatedAt;
      if (stamp !== lastVersion) {
        lastVersion = stamp;
        const data = await fetch(`data/${viewFile}?t=${encodeURIComponent(stamp)}`, { cache: 'no-cache' }).then(r => r.json());
        onData(data);
        if (updatedEl()) {
          const t = new Date(stamp);
          updatedEl().textContent = `updated ${t.toLocaleTimeString()}`;
        }
      }
    } catch (err) {
      // network error or 404 (admin hasn't pushed yet) — quietly retry
      if (updatedEl() && !lastVersion) updatedEl().textContent = 'waiting for data…';
    }
  }

  tick();
  setInterval(tick, POLL_MS);
}
