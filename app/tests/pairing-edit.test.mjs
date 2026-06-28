// Doubles pairing: register partnerless, pair two unpaired entries of the same
// category+class into one team, then unpair back into two solo entries.
import { test, assert } from './lib/harness.mjs';

const key = (name) => decodeURIComponent(encodeURIComponent(name.trim().toLowerCase()));
const reg = (state, name) => state.registrants?.[key(name)] ?? { club: '', present: false, paid: false, paidAmount: 0 };
const findByPlayer = (state, name) => state.participants.find(p => p.players.includes(name));

await test('pairing-edit', async ({ api }) => {
  // Two partnerless MX-B entries with their own clubs, plus a decoy in MX-A.
  await api('POST', '/api/participants', { category: 'MX', class: 'B', players: [{ name: 'John Smith', club: 'TV KA' }] });
  await api('POST', '/api/participants', { category: 'MX', class: 'B', players: [{ name: 'Jane Doe', club: 'BC Nord' }] });
  await api('POST', '/api/participants', { category: 'MX', class: 'A', players: [{ name: 'Other Class', club: 'X' }] });

  let s = await api('GET', '/api/state');
  assert(s.participants.length === 3, `expected 3 entries, got ${s.participants.length}`);
  const john = findByPlayer(s, 'John Smith');
  const jane = findByPlayer(s, 'Jane Doe');
  const decoy = findByPlayer(s, 'Other Class');
  assert(reg(s, 'John Smith').club === 'TV KA' && reg(s, 'Jane Doe').club === 'BC Nord', 'per-person clubs set');
  console.log('✓ created two partnerless MX-B entries with own clubs');

  // Cannot pair across different class.
  let rejected = false;
  try { await api('POST', `/api/participants/${john.id}/pair`, { partnerId: decoy.id }); }
  catch { rejected = true; }
  assert(rejected, 'pairing across different category/class must be rejected');
  console.log('✓ pair rejects mismatched category/class');

  // Pair John + Jane → one team row, Jane's solo row gone, clubs/fees intact.
  await api('POST', `/api/participants/${john.id}/pair`, { partnerId: jane.id });
  s = await api('GET', '/api/state');
  assert(s.participants.length === 2, `after pair expected 2 entries, got ${s.participants.length}`);
  const team = findByPlayer(s, 'John Smith');
  assert(team.players.length === 2 && team.players.includes('Jane Doe'), `team should hold both, got ${JSON.stringify(team.players)}`);
  assert(!s.participants.some(p => p.id === jane.id), "Jane's solo row should be removed");
  assert(reg(s, 'Jane Doe').club === 'BC Nord', 'Jane registrant (club/fee) persists after pairing');
  console.log('✓ paired into one team; partner row merged; per-person data intact');

  // Unpair → two solo MX-B entries again.
  await api('POST', `/api/participants/${team.id}/unpair`);
  s = await api('GET', '/api/state');
  const mxb = s.participants.filter(p => p.category === 'MX' && p.class === 'B');
  assert(mxb.length === 2 && mxb.every(p => p.players.length === 1), `unpair should yield 2 solo MX-B, got ${JSON.stringify(mxb.map(p => p.players))}`);
  console.log('✓ unpaired back into two solo entries');
});
