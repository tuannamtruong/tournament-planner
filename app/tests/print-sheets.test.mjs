// Browser-driven check for the Print tab. Seeds a round-robin group with one
// round of real matches, opens the Print tab, and asserts the score sheets
// render with both player names + the right number of empty set boxes, that the
// per-sheet checkbox toggles `.selected`, the Select-all control flips every
// sheet, and that Download PDF actually produces a non-empty %PDF file.
//
// Run from the repo root so Playwright resolves from node_modules.
import { chromium } from 'playwright';
import { test, assert, addFourPlayers, makeRoundRobinGroup } from './lib/harness.mjs';

await test('print-sheets', async ({ base, api }) => {
  const players = await addFourPlayers(api);            // WS/A: Alice, Bob, Cara, Dan
  const g = await makeRoundRobinGroup(api, players, 'WS-A 1');
  await api('POST', `/api/groups/${g.id}/next-round`);  // 4 players → 2 matches/round

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });

    await page.goto(base + '/');
    await page.click('nav#tabs a[data-tab="print"]');
    await page.waitForSelector('#print-sheets .print-sheet');

    // 4 non-bye players in a round-robin round → 2 matches → 2 sheets.
    const sheetCount = await page.locator('#print-sheets .print-sheet').count();
    assert(sheetCount === 2, `expected 2 sheets, got ${sheetCount}`);

    // Each sheet has two named rows and 3 boxes per row (best-of-3).
    const first = page.locator('#print-sheets .print-sheet').first();
    const names = await first.locator('.ps-name').allInnerTexts();
    assert(names.length === 2 && names.every(n => n.trim().length > 0), `each sheet needs two named players, got ${JSON.stringify(names)}`);
    const boxes = await first.locator('.ps-boxes').first().locator('.ps-box').count();
    assert(boxes === 3, `expected 3 set boxes per player, got ${boxes}`);

    // A blank court line is present for handwriting.
    assert(await first.locator('.ps-court .ps-line').count() === 1, 'sheet should have a blank court line');

    // Toggling a sheet checkbox flips its `.selected` class.
    await first.locator('.ps-check').uncheck();
    assert(!(await first.evaluate(el => el.classList.contains('selected'))), 'unchecking should drop .selected');
    assert(await page.locator('#print-select-all').evaluate(el => el.indeterminate), 'select-all should be indeterminate with a mixed selection');

    // Select-all re-selects every sheet.
    await page.locator('#print-select-all').check();
    const selected = await page.locator('#print-sheets .print-sheet.selected').count();
    assert(selected === 2, `select-all should select all sheets, got ${selected}`);

    // Download PDF produces a real, non-empty PDF.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#print-pdf'),
    ]);
    assert(download.suggestedFilename() === 'score-sheets.pdf', `unexpected filename ${download.suggestedFilename()}`);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const buf = Buffer.concat(chunks);
    assert(buf.length > 500, `PDF too small (${buf.length} bytes)`);
    assert(buf.subarray(0, 5).toString() === '%PDF-', 'download is not a PDF');

    assert(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);
    console.log('✓ Print tab renders score sheets, toggles selection, and exports a PDF');
  } finally {
    await browser.close();
  }
});
