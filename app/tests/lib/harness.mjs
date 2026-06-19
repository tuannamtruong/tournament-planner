// Shared harness for the tests/ feature scripts. Each script boots the REAL
// tournament-planner Fastify server in a hermetic sandbox — a random free port
// and a temp TP_DATA_FILE, with TP_BUCKET='' so there are no AWS calls and no
// collision with a `pnpm dev` the operator may already have on 37325.
//
// Usage from a feature script:
//   import { test, assert } from './lib/harness.mjs';
//   await test('participants', async ({ api }) => {
//     await api('POST', '/api/participants', { ... });
//     assert(cond, 'message');
//   });
//
// `test()` boots a server, runs the body, prints a pass/fail line, cleans up,
// and exits 0/1 — so each script is independently runnable AND aggregatable by
// run-all.mjs. For a long-running server (manual poking) use startServer()
// directly; see serve.mjs.

import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'admin/src/index.ts');
const TSX = path.join(ROOT, 'node_modules/.bin/tsx');

export function pickFreePort() {
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

export function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// A minimal valid tournament so the app doesn't have to invent one and each run
// is deterministic. Override via startServer({ seed }).
function defaultSeed() {
  return {
    tournament: { id: 'tp-test', name: 'Driver Run', updatedAt: new Date().toISOString() },
    participants: [], groups: [], knockouts: [], auditLog: [],
  };
}

// Boots an isolated server. Returns { base, port, dataFile, api, stop }.
// Registers stop() on process exit/SIGINT/SIGTERM so the temp dir is always
// reaped, even on Ctrl-C in serve mode.
export async function startServer({ port, seed } = {}) {
  port ??= await pickFreePort();
  const tmp = mkdtempSync(path.join(tmpdir(), 'tp-test-'));
  const dataFile = path.join(tmp, 'tournament.json');
  writeFileSync(dataFile, JSON.stringify(seed ?? defaultSeed(), null, 2));

  // Spawn detached so the process gets its own group; cleanup kills the group.
  const server = spawn(TSX, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), TP_DATA_FILE: dataFile, TP_BUCKET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server.stdout.on('data', d => { if (process.env.TP_TEST_VERBOSE) process.stdout.write(`[srv] ${d}`); });
  server.stderr.on('data', d => process.stderr.write(`[srv!] ${d}`));

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // tsx forks a node grandchild that escapes the spawn's process group, so a
    // plain server.kill() leaves it bound to the port. Kill the group, then use
    // the random (ours-alone) port as a backstop: lsof the LISTEN pid and kill
    // it. -sTCP:LISTEN avoids matching our own fetch() client sockets.
    if (server.pid) {
      try { process.kill(-server.pid, 'SIGKILL'); } catch {}
      try { server.kill('SIGKILL'); } catch {}
    }
    try {
      const pids = execSync(`lsof -t -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`).toString().trim();
      if (pids) execSync(`kill -KILL ${pids.split('\n').join(' ')} 2>/dev/null || true`);
    } catch {}
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(130); });
  process.on('SIGTERM', () => { stop(); process.exit(143); });

  const base = `http://localhost:${port}`;
  await waitReady(server, base);
  return { base, port, dataFile, api: makeApi(base), stop };
}

function waitReady(server, base) {
  return new Promise((resolve, reject) => {
    server.on('exit', code => {
      if (code !== 0 && code !== null) reject(new Error(`server exited ${code}`));
    });
    const deadline = Date.now() + 30_000;
    (async function poll() {
      while (Date.now() < deadline) {
        try {
          const r = await fetch(`${base}/api/state`);
          if (r.ok) return resolve();
        } catch {}
        await new Promise(r => setTimeout(r, 200));
      }
      reject(new Error('server never came up'));
    })();
  });
}

export function makeApi(base) {
  return async function api(method, p, body) {
    const r = await fetch(base + p, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${await r.text()}`);
    const ct = r.headers.get('content-type') ?? '';
    return ct.includes('json') ? r.json() : r.text();
  };
}

// Boot a server, run fn(ctx), print a pass/fail banner, clean up, exit 0/1.
// `ctx` is the startServer() result, so fn gets { base, port, api, ... }.
export async function test(name, fn, opts) {
  let ctx;
  try {
    ctx = await startServer(opts);
    console.log(`→ ${name}: server on :${ctx.port}`);
    await fn(ctx);
    console.log(`\n✓ ${name}: all checks passed`);
    ctx.stop();
    process.exit(0);
  } catch (err) {
    console.error(`\n✗ ${name} failed:`, err.message);
    if (ctx) ctx.stop();
    process.exit(1);
  }
}

// Seed helpers shared across feature scripts so each can stand up just the
// prerequisites it needs (split scripts can't rely on a prior step's state).
export async function addFourPlayers(api) {
  for (const [name, seed] of [['Alice', 1], ['Bob', 2], ['Cara', 3], ['Dan', 4]]) {
    await api('POST', '/api/participants', { name, club: 'TV Driver', category: 'WS', class: 'A', seed });
  }
  const s = await api('GET', '/api/state');
  return s.participants;
}

export async function makeRoundRobinGroup(api, players, name = 'Group A') {
  await api('POST', '/api/groups', {
    name, mode: 'round_robin', category: 'WS', classes: ['A'],
    members: players.map(p => p.id),
  });
  const s = await api('GET', '/api/state');
  return s.groups.at(-1);
}
