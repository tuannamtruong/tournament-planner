// Import a participant roster from a CSV file into admin/data/tournament.json.
//
// Mirrors the POST /api/participants/import-csv route (same split-on-" & " and
// per-person club logic) but runs offline through storage.mutate, so it works
// without the admin server up. Reusable for any roster CSV.
//
// CSV columns (header row required): name, club, category, class
//   - `name` for doubles joins both players with " & " (e.g. "A Foo & B Bar").
//   - `club` is applied to every player on the row (per-person in registrants).
//   - `category` is one of MS|WS|MD|WD|MX; `class` is one of S|A|B|C|D.
//
// Run with:  npx tsx scripts/import-csv.ts [path/to/roster.csv]
//            (defaults to data/ettlingen.csv)
//
// APPENDS to the existing participants/registrants — wipe first with
// `make wipe-data` if you want a roster-only file.

import { readFileSync } from 'node:fs';
import { parse as parseCsv } from 'csv-parse/sync';
import { nanoid } from 'nanoid';
import { mutate } from '../admin/src/storage.ts';
import type { Registrant } from '../admin/src/schema.ts';

const path = process.argv[2] ?? 'data/ettlingen.csv';
const csv = readFileSync(path, 'utf8');
const rows = parseCsv(csv, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];

const key = (name: string) => name.trim().toLowerCase();
function setRegistrantClub(registrants: Record<string, Registrant>, name: string, club: string) {
  if (!club) return;
  const k = key(name);
  const cur = registrants[k] ?? { club: '', present: false, paid: false, paidAmount: 0 };
  registrants[k] = { ...cur, club };
}

let added = 0;
await mutate(
  { action: 'import_csv', payload: { source: path, count: rows.length } },
  (s) => {
    for (const row of rows) {
      const name = row.name ?? row.Name ?? '';
      if (!name) continue;
      const club = row.club ?? row.Club ?? '';
      const players = name.includes(' & ')
        ? name.split('&').map(p => p.trim()).filter(Boolean)
        : [name.trim()];
      if (!players.length) continue;
      s.participants.push({
        id: nanoid(8),
        withdrawn: false,
        category: row.category ?? row.Category ?? '',
        class: row.class ?? row.Class ?? '',
        players,
      });
      for (const pn of players) setRegistrantClub(s.registrants, pn, club);
      added++;
    }
    return s;
  },
);

console.log(`Imported ${added} entries from ${path}`);
process.exit(0);
