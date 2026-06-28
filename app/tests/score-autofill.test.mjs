// Browser-driven check of the point-systems scoring feature:
//   - Settings defines a library of point systems with a tournament default.
//   - A group/bracket uses the default unless it overrides with another system.
//   - In the Matches tab, entering the LOSER's score auto-fills the winner per
//     that match's resolved system; the deciding (3rd) set can differ; and a
//     manual value is never clobbered (override).
//
// Run from the repo root so Playwright resolves from node_modules.
import { chromium } from 'playwright';
import { test, assert } from './lib/harness.mjs';

await test('score-autofill', async ({ base, api }) => {
  // Library: default "A" (21/30), alternative "B" (15/21, decider 11/21).
  await api('PUT', '/api/state/scoring', {
    systems: [
      { id: 'sa', name: 'A', pointsPerSet: 21, maxPointsPerSet: 30, deciderPoints: 21, deciderMaxPoints: 30 },
      { id: 'sb', name: 'B', pointsPerSet: 15, maxPointsPerSet: 21, deciderPoints: 11, deciderMaxPoints: 21 },
    ],
    defaultId: 'sa',
  });

  const mk = async (name) => (await api('POST', '/api/participants', { category: 'MS', class: 'A', players: [{ name, club: '' }] })).participants.at(-1).id;
  const [a, b, c, d] = [await mk('Alice'), await mk('Bob'), await mk('Carl'), await mk('Dave')];
  // G1 uses the tournament default (A); G2 overrides to B.
  await api('POST', '/api/groups', { name: 'G1', mode: 'round_robin', category: 'MS', classes: ['A'], members: [a, b] });
  await api('POST', '/api/groups', { name: 'G2', mode: 'round_robin', category: 'MS', classes: ['A'], pointSystemId: 'sb', members: [c, d] });
  const s = await api('GET', '/api/state');
  const [g1, g2] = s.groups.slice(-2);
  await api('POST', `/api/groups/${g1.id}/next-round`);
  await api('POST', `/api/groups/${g2.id}/next-round`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(base + '/');

    // Settings shows both systems as editable rows.
    await page.click('nav#tabs a[data-tab="settings"]');
    await page.waitForSelector('#point-systems .point-system-row');
    assert(await page.locator('#point-systems .point-system-row').count() === 2, 'Settings should list 2 point systems');

    // Operator adds a custom system and saves — it persists.
    await page.click('#add-point-system');
    assert(await page.locator('#point-systems .point-system-row').count() === 3, 'add should append a row');
    await page.locator('#point-systems .point-system-row input[placeholder="Name"]').last().fill('Quick 11');
    page.once('dialog', dlg => dlg.accept());   // "Point systems saved."
    await page.click('#save-point-systems');
    await page.waitForTimeout(200);
    const after = await api('GET', '/api/state');
    assert(after.scoring.systems.length === 3 && after.scoring.systems.some(x => x.name === 'Quick 11'),
      `save should persist the added system, got ${JSON.stringify(after.scoring.systems.map(x => x.name))}`);

    await page.click('nav#tabs a[data-tab="matches"]');
    const cell = (gid, idx, side) => `#matches-group-${gid} input.score[data-idx="${idx}"][data-side="${side}"]`;

    // G1 → default system A (target 21): loser 19 → winner 21.
    await page.waitForSelector(cell(g1.id, 0, 'a'));
    await page.fill(cell(g1.id, 0, 'a'), '19');
    await page.press(cell(g1.id, 0, 'a'), 'Tab');
    assert(await page.inputValue(cell(g1.id, 0, 'b')) === '21', `default group: expected 21, got ${await page.inputValue(cell(g1.id, 0, 'b'))}`);

    // G2 → override system B: normal set target 15, decider 11.
    await page.fill(cell(g2.id, 0, 'a'), '9');
    await page.press(cell(g2.id, 0, 'a'), 'Tab');
    assert(await page.inputValue(cell(g2.id, 0, 'b')) === '15', `override normal: expected 15, got ${await page.inputValue(cell(g2.id, 0, 'b'))}`);
    await page.fill(cell(g2.id, 2, 'b'), '9');
    await page.press(cell(g2.id, 2, 'b'), 'Tab');
    assert(await page.inputValue(cell(g2.id, 2, 'a')) === '11', `override decider: expected 11, got ${await page.inputValue(cell(g2.id, 2, 'a'))}`);

    // Override stickiness: a manual winner value is not clobbered.
    await page.fill(cell(g2.id, 1, 'b'), '21');
    await page.fill(cell(g2.id, 1, 'a'), '13');
    await page.press(cell(g2.id, 1, 'a'), 'Tab');
    assert(await page.inputValue(cell(g2.id, 1, 'b')) === '21', `manual override should stick, got ${await page.inputValue(cell(g2.id, 1, 'b'))}`);

    console.log('✓ default vs per-group override resolved; decider differs; auto-fill honors each system; overrides stick');
  } finally {
    await browser.close();
  }
});
