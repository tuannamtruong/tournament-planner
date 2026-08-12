// Browser-driven check: clicking a group's standings table on the Groups tab
// switches to the Matches tab, scrolls to that group's matches card, and
// flashes it. Heavier than the API smokes (drives headless Chromium via
// Playwright), so it lives alongside them but is the slow one in run-all.
//
// Run from the repo root so Playwright resolves from node_modules.
import { chromium } from 'playwright';
import { test, assert, makeRoundRobinGroup } from './lib/harness.mjs';

await test('jump-to-matches', async ({ base, api }) => {
  // Seed: 2 participants, a round-robin group with both, one round.
  const mk = async (name) => (await api('POST', '/api/participants', { category: 'MS', class: 'A', players: [{ name, club: '' }] }));
  await mk('Alice');
  const stateB = await mk('Bob');
  const players = stateB.participants;
  // makeRoundRobinGroup defaults to WS/A; this UI test wants MS/A, so inline it.
  await api('POST', '/api/groups', { name: 'MS-A 1', mode: 'round_robin', category: 'MS', classes: ['A'], members: players.map(p => p.id) });
  let s = await api('GET', '/api/state');
  const g = s.groups.at(-1);
  await api('POST', `/api/groups/${g.id}/next-round`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(base + '/');
    await page.click('nav#tabs a[data-tab="groups"]');
    await page.waitForSelector(`#group-${g.id} table.standings-clickable`);
    const matchesActiveBefore = await page.isVisible('section[data-tab="matches"].active');
    await page.click(`#group-${g.id} table.standings-clickable`);
    await page.waitForTimeout(300);
    const matchesActiveAfter = await page.isVisible('section[data-tab="matches"].active');
    const cardVisible = await page.isVisible(`#matches-group-${g.id}`);
    const flashApplied = await page.evaluate((id) => document.getElementById(id)?.classList.contains('flash'), `matches-group-${g.id}`);

    assert(!matchesActiveBefore, 'matches tab should not be active before the click');
    assert(matchesActiveAfter, 'clicking standings should activate the matches tab');
    assert(cardVisible, "the clicked group's matches card should be visible");
    assert(flashApplied, "the clicked group's matches card should flash");
    console.log('✓ clicking standings jumps to Matches tab and flashes the group card');

    // Inverse: from the Matches tab, the card heading link jumps back to the
    // group's definition card on the Groups tab and flashes it.
    await page.click(`#matches-group-${g.id} h3 a.card-jump`);
    await page.waitForTimeout(300);
    const groupsActiveAfter = await page.isVisible('section[data-tab="groups"].active');
    const defVisible = await page.isVisible(`#group-${g.id}`);
    const defFlash = await page.evaluate((id) => document.getElementById(id)?.classList.contains('flash'), `group-${g.id}`);
    assert(groupsActiveAfter, "clicking the matches card heading should activate the Groups tab");
    assert(defVisible, "the group's definition card should be visible");
    assert(defFlash, "the group's definition card should flash");
    console.log('✓ clicking a matches card heading jumps back to the Groups tab and flashes the group card');

    // A round heading inside the matches card jumps to the same destination.
    await page.click('nav#tabs a[data-tab="matches"]');
    await page.waitForSelector(`#matches-group-${g.id} h4 a.card-jump`);
    await page.click(`#matches-group-${g.id} h4 a.card-jump`);
    await page.waitForTimeout(300);
    const roundGroupsActive = await page.isVisible('section[data-tab="groups"].active');
    const roundDefFlash = await page.evaluate((id) => document.getElementById(id)?.classList.contains('flash'), `group-${g.id}`);
    assert(roundGroupsActive, "clicking a round heading should activate the Groups tab");
    assert(roundDefFlash, "clicking a round heading should flash the group's definition card");
    console.log('✓ clicking a round heading jumps to the same destination as the card heading');
  } finally {
    await browser.close();
  }
});
