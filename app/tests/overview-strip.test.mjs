// Browser-driven check: the sticky overview strip on the Groups / Matches /
// Bracket tabs. It stays hidden at the top of the tab, rides under the nav bar
// once the Overview card scrolls past, carries a per-discipline summary whose
// tags open a compact drill-down popover (category → classes → tables) that
// jumps to a table, scopes to its tab, and the Settings toggle controls the
// bottom-left floating "↑ Overview" button (hidden by default). Heavier than the
// API smokes (drives headless Chromium), so it's one of the slow ones in run-all.
//
// Run from the repo root so Playwright resolves from node_modules.
import { chromium } from 'playwright';
import { test, assert, makeRoundRobinGroup } from './lib/harness.mjs';

await test('overview-strip', async ({ base, api }) => {
  // Seed four round-robin groups (each with a generated round) so the Groups
  // tab is tall enough to scroll the Overview card off the top.
  for (let g = 0; g < 4; g++) {
    for (const [name, seed] of [['A', 1], ['B', 2], ['C', 3], ['D', 4]]) {
      await api('POST', '/api/participants', { name: `${name}${g}`, club: 'C', category: 'WS', class: 'A', seed });
    }
    const s = await api('GET', '/api/state');
    const ps = s.participants.filter(p => p.name.endsWith(String(g)));
    const grp = await makeRoundRobinGroup(api, ps, `Group ${g}`);
    await api('POST', `/api/groups/${grp.id}/next-round`);
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await page.goto(base + '/');
    await page.click('nav#tabs a[data-tab="groups"]');
    await page.waitForTimeout(300);

    // At the top of the tab the strip is hidden (Overview card is in view).
    assert(await page.isHidden('#groups-overview-strip'), 'strip should be hidden at the top of the tab');

    // Scroll past the Overview card → the strip pins under the nav bar.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    assert(await page.isVisible('#groups-overview-strip'), 'strip should appear once the Overview card scrolls past');

    // The strip sits flush beneath the nav bar (its top == nav height).
    const aligned = await page.evaluate(() => {
      const nav = document.querySelector('nav#tabs').getBoundingClientRect();
      const strip = document.querySelector('#groups-overview-strip').getBoundingClientRect();
      return Math.abs(strip.top - nav.bottom) <= 1;
    });
    assert(aligned, 'strip should be pinned directly under the nav bar');

    // The strip carries a compact per-discipline summary so it stays useful
    // once the full Overview card is off-screen. All four groups are WS, so the
    // summary shows the WS tag and a total of 4.
    const summary = await page.innerText('#groups-overview-strip .strip-summary');
    assert(/WS/.test(summary), `strip summary should name the WS discipline (got "${summary}")`);
    assert(/\b4\b/.test(summary), `strip summary should total the four WS groups (got "${summary}")`);

    // Clicking a discipline tag opens the drill-down popover with its classes
    // expanded by default, revealing the (clickable) tables right away.
    await page.click('#groups-overview-strip .strip-summary-item[data-cat="WS"]');
    await page.waitForTimeout(150);
    assert(await page.isVisible('#groups-overview-strip .strip-popover'), 'clicking a discipline tag opens the popover');
    const classes = await page.$$eval('#groups-overview-strip .strip-pop-class > summary', els => els.map(e => e.textContent));
    assert(classes.some(c => /Class A/.test(c)), `popover should list Class A (got ${JSON.stringify(classes)})`);
    assert(await page.evaluate(() => document.querySelector('#groups-overview-strip .strip-pop-class')?.open),
      'category click should expand classes by default');
    const tables = await page.$$eval('#groups-overview-strip .strip-pop-list a', els => els.map(e => e.textContent));
    assert(tables.length === 4, `the expanded class should reveal its four tables (got ${tables.length})`);
    // Popover rows are compact: just the jump link, no mode/members/matches detail.
    const firstRow = await page.innerText('#groups-overview-strip .strip-pop-list li');
    assert(!/member|matches|round_robin/.test(firstRow), `popover rows should be name-only (got "${firstRow}")`);

    const targetHref = await page.getAttribute('#groups-overview-strip .strip-pop-list a', 'href');
    await page.click('#groups-overview-strip .strip-pop-list a');
    await page.waitForTimeout(250);
    assert(await page.isHidden('#groups-overview-strip .strip-popover'), 'clicking a table jumps and closes the popover');
    assert(!!(await page.$(targetHref)), `the jumped-to table ${targetHref} should exist`);

    // Re-scroll past the Overview card (the jump scrolled us up) so the strip is
    // back in view for the remaining checks.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(200);

    // "Expand all" opens every category at once in columns.
    await page.click('#groups-overview-strip .strip-expand');
    await page.waitForTimeout(150);
    assert((await page.$$('#groups-overview-strip .strip-pop-col')).length >= 1,
      'Expand all should open the multi-category popover');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    assert(await page.isHidden('#groups-overview-strip .strip-popover'), 'Escape dismisses the popover');

    // Switching to a tab without an overview hides every strip.
    await page.click('nav#tabs a[data-tab="participants"]');
    await page.waitForTimeout(150);
    assert(await page.isHidden('#groups-overview-strip'), 'strip should hide when its tab is not active');

    // The floating "↑ Overview" button is off by default and the Settings
    // toggle turns it on.
    assert(!(await page.evaluate(() => document.body.classList.contains('show-floating-jump'))),
      'floating button should be hidden by default');
    await page.click('nav#tabs a[data-tab="settings"]');
    await page.check('#toggle-floating-jump');
    assert(await page.evaluate(() => document.body.classList.contains('show-floating-jump')),
      'Settings toggle should reveal the floating Overview button');

    console.log('✓ sticky strip pins under the nav, drills down via its discipline tags, scopes to its tab, and the float toggle works');
  } finally {
    await browser.close();
  }
});
