#!/usr/bin/env node
// Drives the tournament-planner admin app end-to-end against a real Fastify
// instance booted from this script. Uses a temp TP_DATA_FILE and a temp PORT
// so it never collides with a `pnpm dev` the operator already has running.
//
// Usage:
//   node .claude/skills/dev/driver.mjs              # full smoke
//   node .claude/skills/dev/driver.mjs serve        # boot + idle
//   node .claude/skills/dev/driver.mjs --port 38000 # override
//
// In `serve` mode the script keeps the server up so you can curl/chromium-cli
// against it; Ctrl-C stops it and cleans the temp dir.

/*
  A standalone Node script that boots the real tournament-planner Fastify server in a hermetic sandbox 
  and walks the full admin lifecycle, asserting on responses. Two modes:

  Default (smoke) — runs in ~3 s, exits 0/1:

  1. Picks a random free port via net.createServer().listen(0) so it never collides with a pnpm dev the
   operator already has running on 37325.
  2. Creates a temp data file at /tmp/tp-driver-XXX/tournament.json with a minimal valid seed, and
  points the server at it via TP_DATA_FILE=….
  3. Spawns node_modules/.bin/tsx admin/src/index.ts (detached, so it gets its own process group) with
  TP_BUCKET='' to force local-only mode — no AWS calls.
  4. Polls /api/state until 200 (30 s deadline) — fast-fail readiness, not a sleep.
  5. Exercises the API end-to-end via fetch:
    - PUT /api/state/name → assert rename stuck
    - 4× POST /api/participants → assert count
    - POST /api/groups (round-robin, WS/A, all 4 members)
    - POST /api/groups/:id/next-round → assert circle method emitted 2 matches
    - 2× PATCH /api/groups/:gid/matches/:mid (live → done with set scores) → assert
  startedAt/finishedAt were auto-stamped
    - POST /api/knockout { size: 4 } → assert bracket shape
    - GET /view/data/{version,groups,knockout}.json → assert standings was pre-computed in groups.json
    - GET /api/publish/status → assert configured: false
  6. Cleans up: SIGKILL the process group, then lsof -t -iTCP:$PORT -sTCP:LISTEN as a backstop (the tsx
   → node grandchild escapes the pgroup), then rm -rf the temp dir.

  serve mode (node driver.mjs serve --port 38400) — same isolation, but instead of running the smoke
  flow it just keeps the server up and prints the admin/viewer URLs. Ctrl-C runs the same cleanup. Use
  it when you want to curl or point a browser at /view/.

  Flags: --port N to pin a port instead of choosing randomly; TP_DRIVER_VERBOSE=1 to forward the
  Fastify per-request logs (off by default so the output is just the ✓ checks).

  The point of the script is to give an agent (or you) a one-shot way to prove the admin app actually
  works on a clean machine, without touching admin/data/tournament.json or AWS.
*/

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);
const ENTRY = path.join(ROOT, 'admin/src/index.ts');

const args = process.argv.slice(2);
const mode = args.find(a => !a.startsWith('-')) ?? 'smoke';
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : await pickFreePort();
const BASE = `http://localhost:${PORT}`;

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const tmp = mkdtempSync(path.join(tmpdir(), 'tp-driver-'));
const DATA = path.join(tmp, 'tournament.json');
// Seed the data file with a minimal valid tournament so the app doesn't have
// to invent one — and so the smoke run is deterministic.
writeFileSync(DATA, JSON.stringify({
  tournament: { id: 'tp-driver', name: 'Driver Run', updatedAt: new Date().toISOString() },
  participants: [], groups: [], knockouts: [], auditLog: [],
}, null, 2));

let server;
let cleaned = false;
import { execSync } from 'node:child_process';
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  // The spawned child is tsx, which forks node — and that node grandchild does
  // not respond to SIGTERM on its parent. Detached spawn put them in their own
  // process group; we kill the whole group with SIGKILL to be sure. As a final
  // backstop, pkill anything still bound to our specific data-file path (no
  // chance of hitting the operator's `pnpm dev` since the path is per-run).
  if (server && server.pid) {
    try { process.kill(-server.pid, 'SIGKILL'); } catch {}
    try { server.kill('SIGKILL'); } catch {}
  }
  // tsx forks a node grandchild that escapes the process group. The PORT is
  // random and ours alone, so whatever still binds it must be ours — kill it
  // by-fd via lsof (fuser is unreliable on WSL).
  try {
    // -sTCP:LISTEN limits to the listener PID(s); without it we also match our
    // own fetch() client sockets and end up killing this driver process.
    const pids = execSync(`lsof -t -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true`).toString().trim();
    if (pids) execSync(`kill -KILL ${pids.split('\n').join(' ')} 2>/dev/null || true`);
  } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

function bootServer() {
  return new Promise((resolve, reject) => {
    // Use the local tsx binary directly (no `npm exec` shim) and spawn detached
    // so it gets its own process group — cleanup sends SIGTERM to the group.
    const TSX = path.join(ROOT, 'node_modules/.bin/tsx');
    server = spawn(TSX, [ENTRY], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        TP_DATA_FILE: DATA,
        TP_BUCKET: '',  // force local-only mode; no S3 calls
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    // Swallow request-per-line logs but keep crashes visible.
    server.stdout.on('data', d => {
      if (process.env.TP_DRIVER_VERBOSE) process.stdout.write(`[srv] ${d}`);
    });
    server.stderr.on('data', d => process.stderr.write(`[srv!] ${d}`));
    server.on('exit', code => {
      if (code !== 0 && code !== null) reject(new Error(`server exited ${code}`));
    });

    // Poll readiness instead of sleeping; fail fast at 30s.
    const deadline = Date.now() + 30_000;
    (async function poll() {
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${BASE}/api/state`);
          if (r.ok) return resolve();
        } catch {}
        await new Promise(r => setTimeout(r, 200));
      }
      reject(new Error('server never came up'));
    })();
  });
}

async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${await r.text()}`);
  const ct = r.headers.get('content-type') ?? '';
  return ct.includes('json') ? r.json() : r.text();
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function smoke() {
  console.log(`\n→ booting server on :${PORT} with TP_DATA_FILE=${DATA}`);
  await bootServer();
  console.log(`✓ /api/state responds`);

  // 1. Rename
  await api('PUT', '/api/state/name', { name: 'Smoke Cup' });
  let s = await api('GET', '/api/state');
  assert(s.tournament.name === 'Smoke Cup', 'rename did not stick');
  console.log(`✓ rename tournament`);

  // 2. Add four participants (need ≥2 for a manual match, ≥4 to be realistic).
  const players = [];
  for (const [name, seed] of [['Alice', 1], ['Bob', 2], ['Cara', 3], ['Dan', 4]]) {
    await api('POST', '/api/participants', { name, club: 'TV Driver', category: 'WS', class: 'A', seed });
  }
  s = await api('GET', '/api/state');
  assert(s.participants.length === 4, `expected 4 participants, got ${s.participants.length}`);
  players.push(...s.participants);
  console.log(`✓ added 4 participants`);

  // 3. Create a round-robin group with all four.
  await api('POST', '/api/groups', {
    name: 'Group A', mode: 'round_robin', category: 'WS', classes: ['A'],
    members: players.map(p => p.id),
  });
  s = await api('GET', '/api/state');
  const group = s.groups[0];
  assert(group && group.members.length === 4, 'group did not register all 4 members');
  console.log(`✓ created round-robin group ${group.id}`);

  // 4. Generate round 1 — circle method should produce 2 matches for 4 players.
  await api('POST', `/api/groups/${group.id}/next-round`);
  s = await api('GET', '/api/state');
  const round1 = s.groups[0].rounds[0];
  assert(round1?.matches?.length === 2, `expected 2 matches in round 1, got ${round1?.matches?.length}`);
  console.log(`✓ generated round 1 (${round1.matches.length} matches)`);

  // 5. Score the first match, marking it live then done.
  const m = round1.matches[0];
  await api('PATCH', `/api/groups/${group.id}/matches/${m.id}`, { status: 'live', court: '1' });
  await api('PATCH', `/api/groups/${group.id}/matches/${m.id}`, {
    score: [[21, 18], [21, 15]],
    status: 'done',
  });
  s = await api('GET', '/api/state');
  const scored = s.groups[0].rounds[0].matches.find(x => x.id === m.id);
  assert(scored.status === 'done' && scored.startedAt && scored.finishedAt, 'live/done timestamps not stamped');
  console.log(`✓ scored match ${m.id} (status=done, court=${scored.court})`);

  // 6. Create a 4-player knockout so the bracket view has content.
  await api('POST', '/api/knockouts', {
    name: 'WS-A KO',
    category: 'WS', classes: ['A'],
    size: 4,
    seeds: players.map(p => p.id),
  });
  s = await api('GET', '/api/state');
  assert(s.knockouts?.length === 1 && s.knockouts[0].size === 4, 'knockout not created');
  console.log(`✓ created 4-slot bracket ${s.knockouts[0].id}`);

  // 6b. Odd N → round up with byes.
  await api('POST', '/api/knockouts', {
    name: 'Odd Test', category: 'WS', classes: ['A'],
    size: 3, seeds: players.slice(0, 3).map(p => p.id),
  });
  s = await api('GET', '/api/state');
  const odd = s.knockouts[1];
  assert(odd?.size === 4 && odd.rounds[0].slots.length === 2, `odd-N bracket should be padded to size 4 (got ${odd?.size})`);
  console.log(`✓ odd N=3 rounded up to size ${odd.size} with byes`);

  // 7. Public view JSONs — what spectators would fetch from S3.
  const version = await api('GET', '/view/data/version.json');
  const groupsView = await api('GET', '/view/data/groups.json');
  const knockoutView = await api('GET', '/view/data/knockout.json');
  assert(version.name === 'Smoke Cup', 'version.json name wrong');
  assert(Array.isArray(groupsView.groups) && groupsView.groups[0].standings?.length === 4,
         'standings not pre-computed in groups.json');
  assert(Array.isArray(knockoutView?.brackets) && knockoutView.brackets[0].rounds?.[0]?.slots?.length === 2,
         'knockout view shape wrong');
  console.log(`✓ /view/data/{version,groups,knockout}.json render correctly`);

  // 8. Publish status — should be `configured: false` since TP_BUCKET is unset.
  const status = await api('GET', '/api/publish/status');
  assert(status.configured === false, 'expected publish to be unconfigured (TP_BUCKET="")');
  assert(status.pendingChanges > 0, `pendingChanges should reflect prior mutations (got ${status.pendingChanges})`);
  console.log(`✓ publish status: ${JSON.stringify(status)}`);

  // 9. Pending-changes log — every mutation above should have appended an
  // entry. Snapshot blobs are stripped from GET so the response stays small.
  const pendingBefore = await api('GET', '/api/pending');
  assert(pendingBefore.entries.length === status.pendingChanges, 'pending entries should match status counter');
  assert(!('snapshot' in pendingBefore.entries[0]), 'GET /api/pending must strip snapshot blobs');
  assert(pendingBefore.entries.some(e => e.action === 'add_participant'), 'pending log should record add_participant');
  console.log(`✓ pending log has ${pendingBefore.entries.length} entries (snapshots stripped)`);

  // 10. Linear undo: revert from index 1 → discard entries 1..N, keep entry 0 only.
  await api('POST', '/api/pending/revert', { index: 1 });
  const pendingAfter = await api('GET', '/api/pending');
  assert(pendingAfter.entries.length === 1, `revert(1) should leave 1 entry (got ${pendingAfter.entries.length})`);
  const statusAfter = await api('GET', '/api/publish/status');
  assert(statusAfter.pendingChanges === 1, `pendingChanges == 1 after revert (got ${statusAfter.pendingChanges})`);
  const stateAfter = await api('GET', '/api/state');
  assert(stateAfter.participants.length === 0 && stateAfter.groups.length === 0 && stateAfter.knockouts.length === 0,
         'revert from index 1 should restore state to just-after-the-rename (no participants/groups/brackets yet)');
  console.log(`✓ revert from index 1 collapsed state back to just-after-rename`);

  // 11. Revert all → snapshot at index 0 = the seed state before the rename.
  await api('POST', '/api/pending/revert', { mode: 'all' });
  const pendingEmpty = await api('GET', '/api/pending');
  assert(pendingEmpty.entries.length === 0, 'revert all should empty the pending log');
  const baseline = await api('GET', '/api/state');
  assert(baseline.tournament.name === 'Driver Run', 'revert all should restore the seed tournament name');
  console.log(`✓ revert all restored baseline state`);

  // 12. Out-of-range revert errors cleanly (no entries left).
  let threw = false;
  try { await api('POST', '/api/pending/revert', { index: 0 }); } catch { threw = true; }
  assert(threw, 'revert on empty log should 4xx');
  console.log(`✓ revert on empty log rejected`);

  console.log(`\n✓ all smoke checks passed`);
}

async function serve() {
  console.log(`\n→ booting server on :${PORT} with TP_DATA_FILE=${DATA}`);
  console.log(`  admin   → ${BASE}/`);
  console.log(`  viewer  → ${BASE}/view/`);
  console.log(`  Ctrl-C to stop and clean the temp data dir.`);
  await bootServer();
  // Hold the loop open.
  await new Promise(() => {});
}

const handler = mode === 'serve' ? serve : smoke;
try {
  await handler();
  cleanup();
  process.exit(0);
} catch (err) {
  console.error('\n✗ driver failed:', err.message);
  cleanup();
  process.exit(1);
}
