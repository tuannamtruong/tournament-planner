// Participants + tournament rename. Smallest slice of the admin lifecycle.
import { test, assert, addFourPlayers } from './lib/harness.mjs';

await test('participants', async ({ api }) => {
  await api('PUT', '/api/state/name', { name: 'Smoke Cup' });
  let s = await api('GET', '/api/state');
  assert(s.tournament.name === 'Smoke Cup', 'rename did not stick');
  console.log('✓ rename tournament');

  const players = await addFourPlayers(api);
  assert(players.length === 4, `expected 4 participants, got ${players.length}`);
  console.log('✓ added 4 participants');
});
