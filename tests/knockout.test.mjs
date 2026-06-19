// Knockout bracket creation, including odd-N rounding-up with byes.
import { test, assert, addFourPlayers } from './lib/harness.mjs';

await test('knockout', async ({ api }) => {
  const players = await addFourPlayers(api);

  await api('POST', '/api/knockouts', {
    name: 'WS-A KO', category: 'WS', classes: ['A'], size: 4,
    seeds: players.map(p => p.id),
  });
  let s = await api('GET', '/api/state');
  assert(s.knockouts?.length === 1 && s.knockouts[0].size === 4, 'knockout not created');
  console.log(`✓ created 4-slot bracket ${s.knockouts[0].id}`);

  // Odd N → round up to the next power of two with byes.
  await api('POST', '/api/knockouts', {
    name: 'Odd Test', category: 'WS', classes: ['A'], size: 3,
    seeds: players.slice(0, 3).map(p => p.id),
  });
  s = await api('GET', '/api/state');
  const odd = s.knockouts[1];
  assert(odd?.size === 4 && odd.rounds[0].slots.length === 2, `odd-N bracket should be padded to size 4 (got ${odd?.size})`);
  console.log(`✓ odd N=3 rounded up to size ${odd.size} with byes`);
});
