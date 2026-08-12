// Manual first-round bracket pairing edits ("set who plays who"): editing a
// slot's p1/p2 via the slot PATCH must keep the BYE auto-advance + next-round
// propagation consistent.
import { test, assert, addFourPlayers } from './lib/harness.mjs';

await test('pairing-edit-bracket', async ({ api }) => {
  const [alice, bob, cara, dan] = await addFourPlayers(api);

  await api('POST', '/api/knockouts', {
    name: 'WS-A KO', category: 'WS', classes: ['A'], size: 4,
    seeds: [alice.id, bob.id, cara.id, dan.id],
  });
  let kb = (await api('GET', '/api/state')).knockouts[0];
  const r1 = () => kb.rounds.find(r => r.roundNo === 1);
  const r2 = () => kb.rounds.find(r => r.roundNo === 2);
  const slot = (round, n) => round.slots.find(s => s.slot === n);

  // Swap who Alice plays: move Cara out of slot 1 / move Dan in. Edit slot 1's p2.
  let s1 = slot(r1(), 1);
  await api('PATCH', `/api/knockouts/${kb.id}/round/1/slot/1`, { p2: dan.id, baseRev: s1.rev ?? 0 });
  kb = (await api('GET', '/api/state')).knockouts[0];
  s1 = slot(r1(), 1);
  assert(s1.p1 === alice.id && s1.p2 === dan.id, 'slot 1 should now be Alice vs Dan');
  console.log('✓ reassigned a slot opponent');

  // Make slot 1 a BYE by clearing p2 → Alice should auto-advance into round 2.
  await api('PATCH', `/api/knockouts/${kb.id}/round/1/slot/1`, { p2: null, baseRev: s1.rev ?? 0 });
  kb = (await api('GET', '/api/state')).knockouts[0];
  s1 = slot(r1(), 1);
  assert(s1.winner === alice.id && s1.status === 'done', 'lone player should auto-advance by BYE');
  assert(slot(r2(), 1).p1 === alice.id, 'BYE winner should propagate to round 2 slot 1 p1');
  console.log('✓ clearing a side makes a BYE and auto-advances');

  // Undo the BYE: put a real opponent back → winner cleared, round-2 cell cleared.
  await api('PATCH', `/api/knockouts/${kb.id}/round/1/slot/1`, { p2: cara.id, baseRev: s1.rev ?? 0 });
  kb = (await api('GET', '/api/state')).knockouts[0];
  s1 = slot(r1(), 1);
  assert(s1.winner === null && s1.status === 'pending', 'restoring a real match should clear the BYE auto-advance');
  assert(slot(r2(), 1).p1 === null, 'stale BYE winner should be cleared from round 2');
  console.log('✓ restoring a real match undoes the BYE advance');

  // A stale baseRev must still 409 (OCC preserved for pairing edits).
  let conflicted = false;
  try {
    await api('PATCH', `/api/knockouts/${kb.id}/round/1/slot/1`, { p1: bob.id, baseRev: 0 });
  } catch (err) {
    conflicted = /409/.test(String(err.message));
  }
  assert(conflicted, 'a stale baseRev should be rejected with 409');
  console.log('✓ OCC still guards pairing edits');
});
