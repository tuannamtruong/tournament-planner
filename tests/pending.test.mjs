// Pending-changes log (server-rendered tab + summary per mutation) and the
// linear-undo / revert-all semantics. Seeds the full lifecycle first so the log
// has one of each action to assert summary formatting against.
import { test, assert, addFourPlayers, makeRoundRobinGroup } from './lib/harness.mjs';

await test('pending', async ({ api }) => {
  // Seed: rename → 4 participants → group → round → score → 2 brackets.
  await api('PUT', '/api/state/name', { name: 'Smoke Cup' });
  const players = await addFourPlayers(api);
  const group = await makeRoundRobinGroup(api, players);
  await api('POST', `/api/groups/${group.id}/next-round`);
  let s = await api('GET', '/api/state');
  const m = s.groups[0].rounds[0].matches[0];
  await api('PATCH', `/api/groups/${group.id}/matches/${m.id}`, { status: 'live', court: '1' });
  await api('PATCH', `/api/groups/${group.id}/matches/${m.id}`, { score: [[21, 18], [21, 15]], status: 'done' });
  await api('POST', '/api/knockouts', { name: 'WS-A KO', category: 'WS', classes: ['A'], size: 4, seeds: players.map(p => p.id) });
  await api('POST', '/api/knockouts', { name: 'Odd Test', category: 'WS', classes: ['A'], size: 3, seeds: players.slice(0, 3).map(p => p.id) });

  // Log shape: entries match the counter, snapshots stripped from GET.
  const status = await api('GET', '/api/publish/status');
  const pendingBefore = await api('GET', '/api/pending');
  assert(pendingBefore.entries.length === status.pendingChanges, 'pending entries should match status counter');
  assert(!('snapshot' in pendingBefore.entries[0]), 'GET /api/pending must strip snapshot blobs');
  assert(pendingBefore.entries.some(e => e.action === 'add_participant'), 'pending log should record add_participant');
  console.log(`✓ pending log has ${pendingBefore.entries.length} entries (snapshots stripped)`);

  // Each entry carries a server-rendered tab + summary with IDs resolved
  // against its pre-mutation snapshot. Spot-check the formats most likely to
  // silently regress.
  const byAction = new Map(pendingBefore.entries.map(e => [e.action, e]));
  const VALID_TABS = new Set(['participants', 'groups', 'matches', 'bracket', 'settings']);
  for (const e of pendingBefore.entries) {
    assert(VALID_TABS.has(e.tab), `entry #${e.index} (${e.action}) has unknown tab "${e.tab}"`);
    assert(typeof e.summary === 'string' && e.summary.length > 0, `entry #${e.index} (${e.action}) has empty summary`);
  }
  const rename = byAction.get('rename_tournament');
  assert(rename?.tab === 'settings' && rename.summary.includes('Smoke Cup'),
         `rename_tournament summary should mention the new name (got "${rename?.summary}")`);
  const addP = byAction.get('add_participant');
  assert(addP?.tab === 'participants' && /Alice|Bob|Cara|Dan/.test(addP.summary) && /WS/.test(addP.summary),
         `add_participant summary should include player name + category (got "${addP?.summary}")`);
  const createG = byAction.get('create_group');
  assert(createG?.tab === 'groups' && createG.summary.includes('Group A') && createG.summary.includes('WS') && createG.summary.includes('round_robin'),
         `create_group summary should include name + category/class + mode (got "${createG?.summary}")`);
  const genR = byAction.get('generate_round');
  assert(genR?.tab === 'groups' && genR.summary.includes('Group A') && /round 1|R1/i.test(genR.summary),
         `generate_round summary should reference the group and round number (got "${genR?.summary}")`);
  const patchM = byAction.get('patch_match');
  assert(patchM?.tab === 'matches' && patchM.summary.includes('Group A') && / vs /.test(patchM.summary),
         `patch_match summary should resolve player names + group (got "${patchM?.summary}")`);
  const doneMatch = pendingBefore.entries.find(e => e.action === 'patch_match' && /status→done/.test(e.summary));
  assert(doneMatch && /21\D18/.test(doneMatch.summary),
         `patch_match → done summary should include the new score (got "${doneMatch?.summary}")`);
  const createKbWsA = pendingBefore.entries.find(e => e.action === 'create_bracket' && e.summary.includes('WS-A KO'));
  assert(createKbWsA?.tab === 'bracket' && /slot/.test(createKbWsA.summary),
         `create_bracket summary should include name + slot count (got "${createKbWsA?.summary}")`);
  console.log('✓ pending entries carry tab + summary (player names, category/class, scores resolved)');

  // Linear undo: revert from index 1 → discard 1..N, keep entry 0 (the rename).
  await api('POST', '/api/pending/revert', { index: 1 });
  const pendingAfter = await api('GET', '/api/pending');
  assert(pendingAfter.entries.length === 1, `revert(1) should leave 1 entry (got ${pendingAfter.entries.length})`);
  const statusAfter = await api('GET', '/api/publish/status');
  assert(statusAfter.pendingChanges === 1, `pendingChanges == 1 after revert (got ${statusAfter.pendingChanges})`);
  const stateAfter = await api('GET', '/api/state');
  assert(stateAfter.participants.length === 0 && stateAfter.groups.length === 0 && stateAfter.knockouts.length === 0,
         'revert from index 1 should restore state to just-after-the-rename (no participants/groups/brackets yet)');
  console.log('✓ revert from index 1 collapsed state back to just-after-rename');

  // Revert all → snapshot at index 0 = the seed state before the rename.
  await api('POST', '/api/pending/revert', { mode: 'all' });
  const pendingEmpty = await api('GET', '/api/pending');
  assert(pendingEmpty.entries.length === 0, 'revert all should empty the pending log');
  const baseline = await api('GET', '/api/state');
  assert(baseline.tournament.name === 'Driver Run', 'revert all should restore the seed tournament name');
  console.log('✓ revert all restored baseline state');

  // Out-of-range revert on an empty log errors cleanly.
  let threw = false;
  try { await api('POST', '/api/pending/revert', { index: 0 }); } catch { threw = true; }
  assert(threw, 'revert on empty log should 4xx');
  console.log('✓ revert on empty log rejected');
});
