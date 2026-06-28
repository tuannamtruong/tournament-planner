// Per-person check-in + entry-fee ("registrant") behaviour.
//
// The load-bearing rule: payment is PER PERSON, not per participant row. A
// doubles entry is stored as a single "A & B" row shared by two people, but
// each of them checks in and pays their OWN fee. Paying one partner must never
// flip the other. This guards against the earlier "shared doubles fee" bug.
import { test, assert } from './lib/harness.mjs';

// Must match the key the admin UI and backend use verbatim.
const key = (name) => encodeURIComponent(name.trim().toLowerCase());
const reg = (state, name) =>
  state.registrants?.[decodeURIComponent(key(name))] ?? { present: false, paid: false, paidAmount: 0 };

await test('registrants', async ({ api }) => {
  // A singles entry per person plus a shared doubles entry between two of them.
  const entries = [
    { name: 'John Smith', club: 'TV KA', category: 'MS', class: 'A' },
    { name: 'Jane Doe', club: 'BC Nord', category: 'WS', class: 'B' },
    { name: 'John Smith & Jane Doe', club: 'TV KA / BC Nord', category: 'MX', class: 'B' },
  ];
  for (const e of entries) await api('POST', '/api/participants', e);
  console.log('✓ created singles + shared doubles entries');

  // Registrant state is empty until someone is touched.
  let s = await api('GET', '/api/state');
  assert(reg(s, 'John Smith').paid === false, 'fresh registrant should be unpaid');

  // Check in + pay ONLY John. Jane is only checked in.
  await api('PATCH', `/api/registrants/${key('John Smith')}`, { present: true, paid: true, paidAmount: 20 });
  await api('PATCH', `/api/registrants/${key('Jane Doe')}`, { present: true });

  s = await api('GET', '/api/state');
  const john = reg(s, 'John Smith');
  const jane = reg(s, 'Jane Doe');
  assert(john.present && john.paid && john.paidAmount === 20, `John should be present/paid/20, got ${JSON.stringify(john)}`);
  // The core regression assertion: the shared doubles entry must NOT leak John's payment to Jane.
  assert(jane.present === true, 'Jane should be checked in');
  assert(jane.paid === false, 'paying John must NOT mark Jane paid (no shared doubles fee)');
  assert((jane.paidAmount || 0) === 0, 'Jane should owe her own fee, unaffected by John');
  console.log('✓ paying one doubles partner leaves the other unpaid');

  // Total collected is summed per person (each pays once) — the shared doubles
  // row is never double-counted.
  await api('PATCH', `/api/registrants/${key('Jane Doe')}`, { paid: true, paidAmount: 25 });
  s = await api('GET', '/api/state');
  const collected = Object.values(s.registrants).reduce((sum, r) => sum + (r.paidAmount || 0), 0);
  assert(collected === 45, `collected should be 20 + 25 = 45, got ${collected}`);
  console.log('✓ collected total is per-person (no double-count)');

  // A partial registrant patch must not clobber untouched fields.
  await api('PATCH', `/api/registrants/${key('John Smith')}`, { present: false });
  s = await api('GET', '/api/state');
  const john2 = reg(s, 'John Smith');
  assert(john2.present === false && john2.paid === true && john2.paidAmount === 20,
    `partial patch should preserve paid/amount, got ${JSON.stringify(john2)}`);
  console.log('✓ partial registrant patch preserves other fields');

  // Participant rows no longer carry payment fields (moved to registrants).
  const p = s.participants[0];
  assert(!('paid' in p) && !('present' in p) && !('paidAmount' in p),
    `participant rows must not carry payment fields, got keys ${Object.keys(p).join(',')}`);
  console.log('✓ payment lives on registrants, not participant rows');
});
