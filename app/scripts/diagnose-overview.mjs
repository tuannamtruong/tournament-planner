// Diagnostic for the "Groups overview is blank" investigation. Boots an
// isolated admin server against a COPY of a real data file (never mutates the
// operator's tournament.json, never touches S3), then drives headless Chromium
// to check that the admin Groups overview and the result viewer render — with
// console/page-error capture and screenshots. Consolidates the throwaway
// render/seq/view checks written while chasing the blank-overview bug.
//
//   node scripts/diagnose-overview.mjs                       # uses admin/data/tournament.json
//   node scripts/diagnose-overview.mjs --data /path/to.json  # any data file
//   node scripts/diagnose-overview.mjs --keep                # leave server up on its random port
//
// Exit 0 if both surfaces render with no errors, 1 otherwise. Screenshots land
// in debug/screenshots/{diag-admin-groups,diag-viewer}.png.
import { chromium } from 'playwright';
import { startServer } from '../tests/lib/harness.mjs';
import { readFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const dataPath = (() => {
  const i = args.indexOf('--data');
  return i >= 0 ? args[i + 1] : 'admin/data/tournament.json';
})();
const keep = args.includes('--keep');

const seed = JSON.parse(readFileSync(dataPath, 'utf8'));
const ctx = await startServer({ seed }); // isolation: temp copy, TP_BUCKET='', auto-cleanup
const problems = [];

const browser = await chromium.launch();
try {
  mkdirSync('debug/screenshots', { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const state = await ctx.api('GET', '/api/state');
  console.log(`data: ${dataPath} — ${state.groups.length} groups, ${state.participants.length} participants`);

  // --- Admin Groups overview ---
  await page.goto(ctx.base + '/');
  await page.click('nav#tabs a[data-tab="groups"]');
  await page.waitForTimeout(500);
  const len = async () => (await page.innerHTML('#groups-overview')).trim().length;

  const initial = await len();
  console.log(`admin overview html length: ${initial}`);
  if (state.groups.length > 0 && initial === 0) problems.push('admin Groups overview is BLANK while groups exist');
  if (/Couldn.t render overview/.test(await page.innerHTML('#groups-overview'))) {
    problems.push('admin Groups overview hit its error fallback');
  }

  // Interaction sequence: each step should keep the overview populated.
  await page.click('#groups-overview-toggle'); await page.waitForTimeout(200);
  console.log(`  after expand-all: ${await len()}`);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(200);
  await page.click('nav#tabs a[data-tab="matches"]'); await page.waitForTimeout(150);
  await page.click('nav#tabs a[data-tab="groups"]'); await page.waitForTimeout(200);
  console.log(`  after tab round-trip: ${await len()}`);
  await page.screenshot({ path: 'debug/screenshots/diag-admin-groups.png' });

  // --- Result viewer (group stage) ---
  await page.goto(ctx.base + '/view/index.html');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'debug/screenshots/diag-viewer.png' });

  if (errors.length) problems.push(`browser errors:\n  - ${errors.join('\n  - ')}`);

  console.log('\nscreenshots: debug/screenshots/diag-admin-groups.png, diag-viewer.png');
  if (problems.length === 0) {
    console.log('\n✓ overview + viewer render cleanly, no errors');
  } else {
    console.error('\n✗ problems found:\n- ' + problems.join('\n- '));
  }
} finally {
  await browser.close();
  if (keep) console.log(`\nserver left up at ${ctx.base} (Ctrl-C to stop)`);
  else ctx.stop();
}

process.exit(problems.length ? 1 : 0);
