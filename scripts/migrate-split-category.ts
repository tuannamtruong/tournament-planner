// One-off migration: split combined "<CAT>-<CLASS>" category strings
// (e.g. "WS-B") into the new {category, class} pair, and rename "XD" to "MX".
//
// Run with:  npx tsx scripts/migrate-split-category.ts

import { mutate } from '../admin/src/storage.ts';

const CAT_RENAME: Record<string, string> = { XD: 'MX' };

const next = await mutate(
  { action: 'migrate_split_category', target: '', payload: {} },
  (s) => {
    let touched = 0;
    for (const p of s.participants) {
      if (p.class) continue;
      const m = (p.category ?? '').match(/^([A-Za-z]+)(?:[-_ ]([A-Za-z]))?$/);
      if (!m) continue;
      let cat = m[1].toUpperCase();
      cat = CAT_RENAME[cat] ?? cat;
      const cls = (m[2] ?? '').toUpperCase();
      p.category = cat;
      p.class = cls;
      touched++;
    }
    console.log(`migrated ${touched} participant rows`);
    return s;
  },
);

const counts = new Map<string, number>();
for (const p of next.participants) {
  const key = `${p.category}-${p.class || '·'}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
for (const [k, n] of [...counts].sort()) console.log(`  ${k}: ${n}`);
