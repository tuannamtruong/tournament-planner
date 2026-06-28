// Per-person check-in + entry-fee ("registrant") behaviour.
//
// The load-bearing rule: club, check-in and fee are PER PERSON, keyed by
// normalised name — never on the participant row. A doubles team is one row with
// two players, but each player checks in and pays their own fee. Paying one
// partner must never flip the other.
import { test, assert } from './lib/harness.mjs';

const key = (name) => encodeURIComponent(name.trim().toLowerCase());
const reg = (state, name) =>
  state.registrants?.[decodeURIComponent(key(name))] ?? { club: '', present: false, paid: false, paidAmount: 0 };

await test('registrants', async ({ api }) => {
  // A singles entry plus a paired doubles team (two players in one row).
  await api('POST', '/api/participants', { category: 'MS', class: 'A', players: [{ name: 'John Smith', club: 'TV KA' }] });
  await api('POST', '/api/participants', {
    category: 'MX', class: 'B',
    players: [{ name: 'John Smith', club: 'TV KA' }, { name: 'Jane Doe', club: 'BC Nord' }],
  });
  console.log('✓ created singles + paired doubles entries');

  // Club is stored per person from the add payload.
  let s = await api('GET', '/api/state');
  assert(reg(s, 'John Smith').club === 'TV KA', 'John club should be TV KA');
  assert(reg(s, 'Jane Doe').club === 'BC Nord', 'Jane club should be BC Nord');

  // Check in + pay ONLY John. Jane shares the MX row but must be untouched.
  await api('PATCH', `/api/registrants/${key('John Smith')}`, { present: true, paid: true, paidAmount: 20 });
  await api('PATCH', `/api/registrants/${key('Jane Doe')}`, { present: true });

  s = await api('GET', '/api/state');
  const john = reg(s, 'John Smith');
  const jane = reg(s, 'Jane Doe');
  assert(john.present && john.paid && john.paidAmount === 20, `John present/paid/20, got ${JSON.stringify(john)}`);
  assert(jane.present === true, 'Jane checked in');
  assert(jane.paid === false, 'paying John must NOT mark Jane paid (no shared fee)');
  assert((jane.paidAmount || 0) === 0, 'Jane owes her own fee');
  console.log('✓ paying one doubles partner leaves the other unpaid');

  // Partial patch preserves untouched fields incl. club.
  await api('PATCH', `/api/registrants/${key('John Smith')}`, { present: false });
  s = await api('GET', '/api/state');
  const john2 = reg(s, 'John Smith');
  assert(john2.present === false && john2.paid === true && john2.paidAmount === 20 && john2.club === 'TV KA',
    `partial patch preserves club/paid/amount, got ${JSON.stringify(john2)}`);
  console.log('✓ partial registrant patch preserves other fields incl. club');

  // Participant rows carry players[], not payment fields.
  const p = s.participants[0];
  assert(Array.isArray(p.players) && !('paid' in p) && !('present' in p) && !('club' in p),
    `participant row should be players[]-only, got keys ${Object.keys(p).join(',')}`);
  console.log('✓ payment/club live on registrants, participant row is players[]-only');
});
