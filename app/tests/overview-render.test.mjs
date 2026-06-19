// Browser-driven regression guard for the "Groups overview is completely
// blank" bug. renderOverviewTree() builds the whole tree and only swaps it in
// with replaceChildren at the very end, so before the fix any throw while
// building a node left the card silently empty (not even "Nothing here yet").
// This seeds a realistic mix across both overview columns (Singles + Doubles &
// Mix, several classes) and asserts the card actually renders content with no
// page error — i.e. it is never blank when groups exist.
//
// Run from the repo root so Playwright resolves from node_modules.
import { chromium } from 'playwright';
import { test, assert } from './lib/harness.mjs';

await test('overview-render', async ({ base, api }) => {
  // Two singles + two doubles categories across a few classes so both the
  // "Singles" and "Doubles & Mix" columns and the class grouping are exercised.
  const seed = [
    { cat: 'MS', cls: 'A' }, { cat: 'MS', cls: 'B' },
    { cat: 'WS', cls: 'B' },
    { cat: 'MD', cls: 'A' }, { cat: 'MX', cls: 'C' },
  ];
  for (const { cat, cls } of seed) {
    const ids = [];
    for (const n of ['P1', 'P2', 'P3', 'P4']) {
      const s = await api('POST', '/api/participants', { name: `${cat}${cls}-${n}`, club: 'C', category: cat, class: cls, seed: 0 });
      ids.push(s.participants.at(-1).id);
    }
    const g = await api('POST', '/api/groups', { name: `${cat}-${cls} G1`, mode: 'round_robin', category: cat, classes: [cls], members: ids });
    const created = (await api('GET', '/api/state')).groups.at(-1);
    await api('POST', `/api/groups/${created.id}/next-round`);
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });

    await page.goto(base + '/');
    await page.click('nav#tabs a[data-tab="groups"]');
    await page.waitForTimeout(400);

    const html = await page.innerHTML('#groups-overview');
    assert(html.trim().length > 0, 'overview card must not be blank when groups exist');
    assert(!/Nothing here yet/.test(html), 'overview must not claim "Nothing here yet" with 5 groups present');
    assert(!/Couldn.t render overview/.test(html), 'overview must not fall back to its error state on valid data');

    // Both columns should carry their category tags.
    for (const cat of ['MS', 'WS', 'MD', 'MX']) {
      assert(html.includes(`>${cat}<`), `overview should list the ${cat} category`);
    }
    // Group names appear once the class rows are expanded.
    await page.click('#groups-overview-toggle');
    await page.waitForTimeout(200);
    const expanded = await page.innerHTML('#groups-overview');
    assert(expanded.includes('MS-A G1'), 'expanding the overview should reveal group names');

    assert(pageErrors.length === 0, `overview render must not throw: ${pageErrors.join(' | ')}`);
    console.log('✓ Groups overview renders both columns with no error and is never blank');
  } finally {
    await browser.close();
  }
});
