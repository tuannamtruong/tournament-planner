import { load } from '../admin/src/storage.ts';
import { computeStandings } from '../admin/src/standings.ts';

const t = await load();
for (const g of t.groups.slice(0, 5)) {
  console.log('---', g.name, '---');
  const s = computeStandings(g, t.participants);
  for (const r of s) {
    console.log(`  ${r.rank} ${r.name}  W=${r.won} L=${r.lost}  sets=${r.setsWon}-${r.setsLost}  pts=${r.pointsWon}-${r.pointsLost}`);
  }
}
