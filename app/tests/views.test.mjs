// Public view JSONs (what spectators fetch from S3) + publish status.
// Seeds a scored group and a bracket so the derived views have content.
import { test, assert, addFourPlayers, makeRoundRobinGroup } from './lib/harness.mjs';

await test('views', async ({ api }) => {
  await api('PUT', '/api/state/name', { name: 'Smoke Cup' });
  const players = await addFourPlayers(api);
  const group = await makeRoundRobinGroup(api, players);
  await api('POST', `/api/groups/${group.id}/next-round`);
  await api('POST', '/api/knockouts', {
    name: 'WS-A KO', category: 'WS', classes: ['A'], size: 4, seeds: players.map(p => p.id),
  });

  const version = await api('GET', '/view/data/version.json');
  const groupsView = await api('GET', '/view/data/groups.json');
  const knockoutView = await api('GET', '/view/data/knockout.json');
  assert(version.name === 'Smoke Cup', 'version.json name wrong');
  assert(Array.isArray(groupsView.groups) && groupsView.groups[0].standings?.length === 4,
         'standings not pre-computed in groups.json');
  assert(Array.isArray(knockoutView?.brackets) && knockoutView.brackets[0].rounds?.[0]?.slots?.length === 2,
         'knockout view shape wrong');
  console.log('✓ /view/data/{version,groups,knockout}.json render correctly');

  // TP_BUCKET='' → publish unconfigured; counter reflects prior mutations.
  const status = await api('GET', '/api/publish/status');
  assert(status.configured === false, 'expected publish to be unconfigured (TP_BUCKET="")');
  assert(status.pendingChanges > 0, `pendingChanges should reflect prior mutations (got ${status.pendingChanges})`);
  console.log(`✓ publish status: ${JSON.stringify(status)}`);
});
