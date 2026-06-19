// Match scoring: live → done with set scores, and startedAt/finishedAt
// auto-stamping.
import { test, assert, addFourPlayers, makeRoundRobinGroup } from './lib/harness.mjs';

await test('scoring', async ({ api }) => {
  const players = await addFourPlayers(api);
  const group = await makeRoundRobinGroup(api, players);
  await api('POST', `/api/groups/${group.id}/next-round`);
  let s = await api('GET', '/api/state');
  const m = s.groups[0].rounds[0].matches[0];

  await api('PATCH', `/api/groups/${group.id}/matches/${m.id}`, { status: 'live', court: '1' });
  await api('PATCH', `/api/groups/${group.id}/matches/${m.id}`, { score: [[21, 18], [21, 15]], status: 'done' });

  s = await api('GET', '/api/state');
  const scored = s.groups[0].rounds[0].matches.find(x => x.id === m.id);
  assert(scored.status === 'done' && scored.startedAt && scored.finishedAt, 'live/done timestamps not stamped');
  console.log(`✓ scored match ${m.id} (status=done, court=${scored.court})`);
});
