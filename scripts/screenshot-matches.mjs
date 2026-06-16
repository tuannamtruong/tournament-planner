#!/usr/bin/env node
// Screenshots the bracket-grid match layout in both surfaces against a
// hermetic dev server. Complements scripts/screenshot-views.mjs (which only
// shoots the collapsed result-site landing) by:
//   1) seeding one 4-player round-robin group with mixed match statuses
//      (done with three sets, live with one set, untouched);
//   2) shooting the public result-site index.html with all group <details>
//      expanded so the new .bracket-match rows render;
//   3) driving the admin UI to the Groups and Matches tabs and shooting
//      those too so the editable variant is visible.
//
// Output: debug/screenshots/{matches-expanded,admin-groups,admin-matches}.png.
//
// Run:
//   node scripts/screenshot-matches.mjs
//   node scripts/screenshot-matches.mjs --keep   # leave the server running
//
// Requires Playwright Chromium (devDependency; run `npx playwright install
// chromium` once after `npm install` if it complains about missing binaries).

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
const tmp = mkdtempSync(path.join(tmpdir(), 'tp-mshot-'));
const DATA = path.join(tmp, 'tournament.json');
writeFileSync(DATA, JSON.stringify({
  tournament: { id: 'tp-mshot', name: 'Match Cup', updatedAt: new Date().toISOString() },
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
    try { const r = await fetch(`${BASE}/api/state`); if (r.ok) return; } catch {}
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

async function seed() {
  // 4 singles players → round-robin yields 3 rounds (each player plays 3
  // matches). One scored to completion, one live, one untouched gives us a
  // mix of bracket-match states to render.
  const ids = [];
  for (let i = 1; i <= 4; i++) {
    const state = await api('POST', '/api/participants', {
      name: `Player ${i}`, club: 'Club X', category: 'MS', class: 'A', seed: i,
    });
    ids.push(state.participants.find(p => p.name === `Player ${i}`).id);
  }
  await api('POST', '/api/groups', {
    name: 'MS-A Group 1', mode: 'round_robin', category: 'MS', classes: ['A'], members: ids,
  });
  const state = await api('GET', '/api/state');
  const g = state.groups[0];
  await api('POST', `/api/groups/${g.id}/next-round`);
  await api('POST', `/api/groups/${g.id}/next-round`);

  const fresh = await api('GET', '/api/state');
  const grp = fresh.groups[0];
  const m1 = grp.rounds[0].matches[0];
  const m2 = grp.rounds[0].matches[1];
  await api('PATCH', `/api/groups/${grp.id}/matches/${m1.id}`, {
    score: [[21, 15], [18, 21], [21, 17]], status: 'done', court: '1',
  });
  await api('PATCH', `/api/groups/${grp.id}/matches/${m2.id}`, {
    score: [[15, 10]], status: 'live', court: '2',
  });

  // A 4-slot bracket seeded by the four players so the admin bracket tab
  // shows the new .bracket-match slot rendering too.
  await api('POST', '/api/knockouts', {
    name: 'MS-A KO', category: 'MS', classes: ['A'], size: 4, seeds: ids,
  });
}

async function shoot() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 1400 } });
  const page = await ctx.newPage();

  // Public result site, all groups expanded.
  await page.goto(`${BASE}/view/index.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    document.querySelectorAll('details.group').forEach(d => { d.open = true; });
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, 'matches-expanded.png'), fullPage: true });
  console.log(`✓ debug/screenshots/matches-expanded.png`);

  // Admin → Groups tab (renderGroupstage).
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  await page.click('nav#tabs a[data-tab="groups"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'admin-groups.png'), fullPage: true });
  console.log(`✓ debug/screenshots/admin-groups.png`);

  // Admin → Matches tab.
  await page.click('nav#tabs a[data-tab="matches"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'admin-matches.png'), fullPage: true });
  console.log(`✓ debug/screenshots/admin-matches.png`);

  // Admin → Bracket tab.
  await page.click('nav#tabs a[data-tab="bracket"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'admin-bracket.png'), fullPage: true });
  console.log(`✓ debug/screenshots/admin-bracket.png`);

  await browser.close();
}

console.log(`→ booting on :${PORT}`);
await bootServer();
console.log(`✓ server up`);
await seed();
console.log(`✓ seeded`);
await shoot();
if (KEEP) {
  console.log(`\nServer left running at ${BASE}/ (Ctrl-C to stop).`);
  process.stdin.resume();
}
