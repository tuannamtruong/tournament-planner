#!/usr/bin/env node
// Screenshots the result-site pages against a hermetic dev server. Seeds enough
// data to exercise both the 5-column category tree and the bracket layouts
// (inline ≤4-round vs the 2+3 split at 5 rounds), then PNGs each page with
// Playwright Chromium. Output: debug/screenshots/*.png.
//
// Run:
//   node scripts/screenshot-views.mjs
//   node scripts/screenshot-views.mjs --keep   # leave the server running
//
// Requires: `npm i` already ran (playwright is a devDependency) and
// `npx playwright install chromium` has been done at least once.

import { spawn, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const ENTRY = path.join(ROOT, 'admin/src/index.ts');
const OUT = path.join(ROOT, 'debug/screenshots');
const KEEP = process.argv.includes('--keep');

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

const PORT = await pickFreePort();
const BASE = `http://localhost:${PORT}`;
const tmp = mkdtempSync(path.join(tmpdir(), 'tp-shot-'));
const DATA = path.join(tmp, 'tournament.json');
writeFileSync(DATA, JSON.stringify({
  tournament: { id: 'tp-shot', name: 'Screenshot Cup', updatedAt: new Date().toISOString() },
  participants: [], groups: [], knockouts: [], auditLog: [],
}, null, 2));

let server;
function cleanup() {
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGKILL'); } catch {}
    try { server.kill('SIGKILL'); } catch {}
  }
  try {
    const pids = execSync(`lsof -t -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true`).toString().trim();
    if (pids) execSync(`kill -KILL ${pids.split('\n').join(' ')} 2>/dev/null || true`);
  } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}
if (!KEEP) {
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
}

async function bootServer() {
  const TSX = path.join(ROOT, 'node_modules/.bin/tsx');
  server = spawn(TSX, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), TP_DATA_FILE: DATA, TP_BUCKET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server.stderr.on('data', d => process.stderr.write(`[srv!] ${d}`));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/state`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server never came up');
}

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${await r.text()}`);
  const ct = r.headers.get('content-type') ?? '';
  return ct.includes('json') ? r.json() : r.text();
}

// Seed: every category populated, two classes (S/A) where useful, plus one
// big 32-slot bracket so the 2+3 row split renders.
async function seed() {
  const plan = [
    { cat: 'MS', cls: 'S', count: 16, label: 'MSS' }, // → 32-slot bracket (5 rounds, with byes)
    { cat: 'MS', cls: 'A', count: 8,  label: 'MSA' },
    { cat: 'WS', cls: 'S', count: 6,  label: 'WSS' },
    { cat: 'WS', cls: 'A', count: 4,  label: 'WSA' },
    { cat: 'MD', cls: 'S', count: 4,  label: 'MDS' },
    { cat: 'WD', cls: 'A', count: 4,  label: 'WDA' },
    { cat: 'MX', cls: 'B', count: 4,  label: 'MXB' },
  ];
  const ids = {};
  for (const b of plan) {
    ids[b.label] = [];
    for (let i = 1; i <= b.count; i++) {
      // POST returns the full mutated state, not the new row, so grab the
      // last participant by name from the response.
      const state = await api('POST', '/api/participants', {
        name: `${b.label}-P${i}`, club: 'Club X', category: b.cat, class: b.cls, seed: i,
      });
      const created = state.participants.find(p => p.name === `${b.label}-P${i}`);
      ids[b.label].push(created.id);
    }
  }

  // Groups: round-robin in MS/A and WS/A, swiss in MD/S so the tree shows variety.
  await api('POST', '/api/groups', {
    name: 'MS-A Group 1', mode: 'round_robin', category: 'MS', classes: ['A'], members: ids.MSA.slice(0, 4),
  });
  await api('POST', '/api/groups', {
    name: 'MS-A Group 2', mode: 'round_robin', category: 'MS', classes: ['A'], members: ids.MSA.slice(4, 8),
  });
  await api('POST', '/api/groups', {
    name: 'WS-A', mode: 'round_robin', category: 'WS', classes: ['A'], members: ids.WSA,
  });
  await api('POST', '/api/groups', {
    name: 'MD-S', mode: 'swiss', category: 'MD', classes: ['S'], members: ids.MDS,
  });
  await api('POST', '/api/groups', {
    name: 'MX-B', mode: 'manual', category: 'MX', classes: ['B'], members: ids.MXB,
  });

  // Brackets: 32-slot for MS/S so we see the 5-round 2+3 split, and an 8-slot
  // for WS/S so we see the simpler inline layout side-by-side.
  await api('POST', '/api/knockouts', {
    name: 'MS-S Knockout', category: 'MS', classes: ['S'], size: 32, seeds: ids.MSS,
  });
  await api('POST', '/api/knockouts', {
    name: 'WS-S Knockout', category: 'WS', classes: ['S'], size: 8, seeds: ids.WSS,
  });
  await api('POST', '/api/knockouts', {
    name: 'WD-A Knockout', category: 'WD', classes: ['A'], size: 4, seeds: ids.WDA,
  });

  // Score the first R1 match of the 32-slot bracket so a winner shows bolded
  // in the screenshot.
  const state = await api('GET', '/api/state');
  const bigKb = state.knockouts.find(k => k.name === 'MS-S Knockout');
  const firstSlot = bigKb.rounds[0].slots[0];
  if (firstSlot.p1 && firstSlot.p2) {
    await api('PATCH', `/api/knockouts/${bigKb.id}/round/1/slot/1`, {
      score: [[21, 18], [21, 15]],
      winner: firstSlot.p1,
    });
  }
}

async function shoot() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 2000 } });
  const page = await ctx.newPage();

  const targets = [
    { url: `${BASE}/view/index.html`,    out: 'index.png' },
    { url: `${BASE}/view/knockout.html`, out: 'knockout.png' },
  ];
  for (const t of targets) {
    await page.goto(t.url, { waitUntil: 'networkidle' });
    // The renderers fetch their JSON after DOMContentLoaded; networkidle covers it
    // but give a tiny buffer for the second paint.
    await page.waitForTimeout(150);
    const file = path.join(OUT, t.out);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`✓ ${path.relative(ROOT, file)}`);
  }
  await browser.close();
}

console.log(`→ booting server on :${PORT}`);
await bootServer();
console.log(`✓ server up`);
await seed();
console.log(`✓ seeded data`);
await shoot();
if (KEEP) {
  console.log(`\nServer left running at ${BASE}/view/ (Ctrl-C to stop).`);
  process.stdin.resume();
} else {
  console.log(`\n${path.relative(ROOT, OUT)}/ has the PNGs.`);
}
