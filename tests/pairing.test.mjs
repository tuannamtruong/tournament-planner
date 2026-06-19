// Round-robin group creation + first-round pairing (circle method).
import { test, assert, addFourPlayers, makeRoundRobinGroup } from './lib/harness.mjs';

await test('pairing', async ({ api }) => {
  const players = await addFourPlayers(api);
  const group = await makeRoundRobinGroup(api, players);
  assert(group && group.members.length === 4, 'group did not register all 4 members');
  console.log(`✓ created round-robin group ${group.id}`);

  // Circle method: 4 players → 2 matches in round 1.
  await api('POST', `/api/groups/${group.id}/next-round`);
  const s = await api('GET', '/api/state');
  const round1 = s.groups[0].rounds[0];
  assert(round1?.matches?.length === 2, `expected 2 matches in round 1, got ${round1?.matches?.length}`);
  console.log(`✓ generated round 1 (${round1.matches.length} matches)`);
});
