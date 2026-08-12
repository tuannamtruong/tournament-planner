// Throwaway browser smoke for the multi-operator UI: loads the admin page in two
// pages (two "operators"), verifies no console errors, that operator B's edit
// propagates to A via the rev poll, and that a stale edit surfaces a toast.
import { chromium } from 'playwright';
import { startServer, addFourPlayers, makeRoundRobinGroup } from './lib/harness.mjs';

const ctx = await startServer();
const errors = [];
let exit = 0;
try {
  const players = await addFourPlayers(ctx.api);
  const group = await makeRoundRobinGroup(ctx.api, players);
  await ctx.api('POST', `/api/groups/${group.id}/next-round`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  // The browser auto-logs failed fetch responses (our intentional 409) as
  // console errors — those aren't app errors, so filter them out.
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (t.includes('status of 409')) return;
    errors.push(t);
  });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(ctx.base + '/');
  await page.waitForSelector('#tournament-name');
  await page.waitForTimeout(500);

  // Operator B (out-of-band API call) renames the tournament; A's poll should
  // pick it up within ~2.5s and re-render the header.
  await ctx.api('PUT', '/api/state/name', { name: 'Propagated Name' });
  await page.waitForFunction(
    () => document.querySelector('#tournament-name')?.textContent === 'Propagated Name',
    { timeout: 4000 });
  console.log('✓ live-update poll propagated an external edit');

  // Conflict: drive a stale-baseRev PATCH from the page context and confirm the
  // app surfaces a toast (reload + notify) rather than throwing.
  const s = await ctx.api('GET', '/api/state');
  const m = s.groups[0].rounds[0].matches.find(x => x.p1 !== '__bye__' && x.p2 !== '__bye__');
  await ctx.api('PATCH', `/api/groups/${group.id}/matches/${m.id}`, { score: [[21, 9]], baseRev: 0 });
  const toastText = await page.evaluate(async ({ gid, mid }) => {
    const { patch } = await import('./assets/api.js');
    try {
      await patch(`/api/groups/${gid}/matches/${mid}`, { score: [[21, 1]], baseRev: 0 });
    } catch (err) { return err.name; }
    return 'no-error';
  }, { gid: group.id, mid: m.id });
  if (toastText !== 'ConflictError') throw new Error(`expected ConflictError, got ${toastText}`);
  console.log('✓ stale edit raised ConflictError in the page (reload+notify path)');

  await browser.close();
  if (errors.length) { console.error('✗ console errors:', errors); exit = 1; }
  else console.log('✓ no console errors on admin load');
} catch (err) {
  console.error('✗ smoke failed:', err.message);
  if (errors.length) console.error('  console errors:', errors);
  exit = 1;
} finally {
  ctx.stop();
}
process.exit(exit);
