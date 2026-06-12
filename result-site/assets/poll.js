// One-shot loader: fetch version.json then the named view file once on page
// load. Spectators see new data by refreshing or reopening the page. Errors
// are swallowed (offline = stale data, not a broken page). Both URLs are
// relative so the same code works from S3 or localhost.

const updatedEl = () => document.getElementById('updated');

export async function loadView(viewFile, onData) {
  try {
    const v = await fetch(`data/version.json?t=${Date.now()}`, { cache: 'no-cache' }).then(r => r.json());
    const stamp = v.updatedAt;
    const data = await fetch(`data/${viewFile}?t=${encodeURIComponent(stamp)}`, { cache: 'no-cache' }).then(r => r.json());
    onData(data);
    if (updatedEl()) {
      const t = new Date(stamp);
      updatedEl().textContent = `updated ${t.toLocaleTimeString()}`;
    }
  } catch (err) {
    if (updatedEl()) updatedEl().textContent = 'waiting for data…';
  }
}
