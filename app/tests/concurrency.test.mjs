// Multi-operator optimistic-concurrency checks: per-record rev bumping, the
// /api/state/rev live-update probe, and 409 Conflict on a stale baseRev (with
// the server's current record handed back for reload+notify).
import { test, assert, addFourPlayers, makeRoundRobinGroup } from './lib/harness.mjs';

// Raw request that does NOT throw on non-2xx, so we can assert on status + body.
async function raw(base, method, p, body) {
  const r = await fetch(base + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, json, text };
}

await test('concurrency', async ({ base, api }) => {
  const players = await addFourPlayers(api);
  const group = await makeRoundRobinGroup(api, players);
  await api('POST', `/api/groups/${group.id}/next-round`);

  // -- global rev + /api/state/rev probe --------------------------------------
  let s = await api('GET', '/api/state');
  const rev0 = s.rev;
  assert(typeof rev0 === 'number' && rev0 > 0, 'global rev is a positive number after edits');
  const probe = await api('GET', '/api/state/rev');
  assert(probe.rev === rev0, '/api/state/rev matches state.rev');
  assert(typeof probe.updatedAt === 'string', '/api/state/rev returns updatedAt');

  // Find a real (non-bye) match to score.
  const round = s.groups[0].rounds[0];
  const match = round.matches.find(m => m.p1 !== '__bye__' && m.p2 !== '__bye__');
  assert(match, 'round has a playable match');
  assert((match.rev ?? 0) === 0, 'fresh match starts at rev 0');

  // -- per-record rev bump ----------------------------------------------------
  const ok1 = await raw(base, 'PATCH', `/api/groups/${group.id}/matches/${match.id}`,
    { score: [[21, 10]], status: 'done', baseRev: 0 });
  assert(ok1.status === 200, `first score edit succeeds (got ${ok1.status})`);
  assert(ok1.json.rev === rev0 + 1, 'global rev bumped by one');
  s = await api('GET', '/api/state');
  const m1 = s.groups[0].rounds[0].matches.find(m => m.id === match.id);
  assert((m1.rev ?? 0) === 1, 'match rev bumped to 1');
  assert(m1.lastEditor, 'match records a lastEditor');

  // -- OCC: stale baseRev is rejected with 409 + current ----------------------
  const stale = await raw(base, 'PATCH', `/api/groups/${group.id}/matches/${match.id}`,
    { score: [[21, 5]], baseRev: 0 });
  assert(stale.status === 409, `stale baseRev rejected with 409 (got ${stale.status})`);
  assert(stale.json?.current?.rev === 1, '409 body carries the current record (rev 1)');
  // The losing edit must NOT have been applied.
  s = await api('GET', '/api/state');
  const m2 = s.groups[0].rounds[0].matches.find(m => m.id === match.id);
  assert(JSON.stringify(m2.score) === JSON.stringify([[21, 10]]), 'conflicting edit did not clobber the score');

  // -- OCC: correct baseRev succeeds ------------------------------------------
  const ok2 = await raw(base, 'PATCH', `/api/groups/${group.id}/matches/${match.id}`,
    { score: [[21, 18]], baseRev: 1 });
  assert(ok2.status === 200, `edit with current baseRev succeeds (got ${ok2.status})`);
  s = await api('GET', '/api/state');
  const m3 = s.groups[0].rounds[0].matches.find(m => m.id === match.id);
  assert((m3.rev ?? 0) === 2, 'match rev bumped to 2');

  // -- edits to DIFFERENT matches never conflict ------------------------------
  const other = s.groups[0].rounds[0].matches.find(
    m => m.id !== match.id && m.p1 !== '__bye__' && m.p2 !== '__bye__');
  if (other) {
    const okOther = await raw(base, 'PATCH', `/api/groups/${group.id}/matches/${other.id}`,
      { score: [[21, 0]], baseRev: other.rev ?? 0 });
    assert(okOther.status === 200, 'editing a different match is unaffected by the first match rev');
  }

  // -- omitting baseRev opts out of OCC (legacy/no-conflict path) --------------
  const noBase = await raw(base, 'PATCH', `/api/groups/${group.id}/matches/${match.id}`,
    { court: 'C3' });
  assert(noBase.status === 200, 'patch without baseRev still applies (OCC opt-out)');

  console.log('  ✓ rev probe, per-record bump, 409 on stale baseRev, no-clobber, disjoint edits');
});
