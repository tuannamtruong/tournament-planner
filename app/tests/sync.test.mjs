// Two-"laptop" sync convergence over a shared folder (FilesystemStore), which
// implements the same If-Match/ETag contract as the S3 store — so this exercises
// the real pull→merge→push loop end to end without AWS. Each laptop is its own
// server process with its own data file; they share one TP_SYNC_DIR.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, assert } from './lib/harness.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'tp-sync-'));
const env = { TP_SYNC_DIR: dir, TP_SYNC_INTERVAL_MS: '400' };

const addPlayer = (api, name) =>
  api('POST', '/api/participants', { category: 'WS', class: 'A', players: [{ name, club: 'C' }] });
const names = async (api) =>
  (await api('GET', '/api/state')).participants.map(p => p.players[0]).sort();

async function waitFor(fn, label, ms = 12000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

let a, b, exit = 0;
try {
  a = await startServer({ env: { ...env, TP_NODE_ID: 'laptopA' } });
  b = await startServer({ env: { ...env, TP_NODE_ID: 'laptopB' } });
  console.log(`→ sync: A on :${a.port}, B on :${b.port}, dir ${dir}`);

  // Edit on A → appears on B.
  await addPlayer(a.api, 'Alice');
  await waitFor(async () => (await names(b.api)).includes('Alice'), "B sees A's add");
  console.log("✓ A's edit propagated to B");

  // Concurrent disjoint adds on both → both converge to the union (no conflict).
  await Promise.all([addPlayer(a.api, 'Cara'), addPlayer(b.api, 'Bob')]);
  const want = ['Alice', 'Bob', 'Cara'];
  await waitFor(async () => JSON.stringify(await names(a.api)) === JSON.stringify(want), 'A converged');
  await waitFor(async () => JSON.stringify(await names(b.api)) === JSON.stringify(want), 'B converged');
  console.log('✓ concurrent disjoint adds converged on both laptops');

  // Neither laptop reports a sync conflict for disjoint edits.
  const sa = await a.api('GET', '/api/sync/status');
  const sb = await b.api('GET', '/api/sync/status');
  assert(sa.online && sb.online, 'both laptops online');
  assert(sa.conflicts.length === 0 && sb.conflicts.length === 0, 'no spurious conflicts on disjoint edits');
  console.log('✓ both online, no spurious conflicts');

  console.log('\n✓ sync: all checks passed');
} catch (err) {
  console.error('\n✗ sync failed:', err.message);
  exit = 1;
} finally {
  if (a) a.stop();
  if (b) b.stop();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
process.exit(exit);
