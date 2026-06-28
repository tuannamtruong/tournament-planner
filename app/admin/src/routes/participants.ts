import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { parse as parseCsv } from 'csv-parse/sync';
import { z } from 'zod';
import { mutate } from '../storage.ts';
import { propagate as propagateBracketWinner } from './knockout.ts';

// One player on an entry: their display name + own club. Singles send one,
// doubles up to two (or one to register partnerless and pair later).
const PlayerInput = z.object({ name: z.string().min(1), club: z.string().default('') });

const NewParticipant = z.object({
  category: z.string().min(1),
  class: z.string().min(1),
  players: z.array(PlayerInput).min(1).max(2),
});

const PatchParticipant = z.object({
  category: z.string().min(1).optional(),
  class: z.string().min(1).optional(),
  withdrawn: z.boolean().optional(),
  players: z.array(PlayerInput).min(1).max(2).optional(),
});

// Per-person check-in + fee patch. `key` is the normalised person name the UI
// derives; the body is a partial Registrant.
const PatchRegistrant = z.object({
  club: z.string().optional(),
  present: z.boolean().optional(),
  paid: z.boolean().optional(),
  paidAmount: z.number().nonnegative().optional(),
});

const Pair = z.object({ partnerId: z.string().min(1) });

// Normalised person key — must match the admin UI's personKey(). Per-person
// data (club, check-in, fee) lives in state.registrants under this key.
const key = (name: string) => name.trim().toLowerCase();
function setRegistrantClub(s: { registrants: Record<string, { club: string; present: boolean; paid: boolean; paidAmount: number }> }, name: string, club: string) {
  if (!club) return;
  const k = key(name);
  const cur = s.registrants[k] ?? { club: '', present: false, paid: false, paidAmount: 0 };
  s.registrants[k] = { ...cur, club };
}

export async function participantRoutes(app: FastifyInstance) {
  app.post('/api/participants', async (req) => {
    const p = NewParticipant.parse(req.body);
    return mutate(
      { action: 'add_participant', payload: p },
      (s) => {
        s.participants.push({
          id: nanoid(8), withdrawn: false,
          category: p.category, class: p.class,
          players: p.players.map(pl => pl.name),
        });
        for (const pl of p.players) setRegistrantClub(s, pl.name, pl.club);
        return s;
      },
    );
  });

  // Bulk check-in: mark every person across all participant entries present.
  // Settings exposes a one-click button for this — handy when the whole field
  // has arrived and per-person check-in in Registration would be tedious.
  // Returns the count of people now present so the UI can confirm.
  app.post('/api/registrants/mark-all-present', async () => {
    const names = new Set<string>();
    const state = await mutate(
      { action: 'mark_all_present' },
      (s) => {
        for (const p of s.participants) for (const nm of p.players) names.add(key(nm));
        for (const k of names) {
          const cur = s.registrants[k] ?? { club: '', present: false, paid: false, paidAmount: 0 };
          s.registrants[k] = { ...cur, present: true };
        }
        return s;
      },
    );
    return { ...state, markedPresent: names.size };
  });

  app.patch('/api/registrants/:key', async (req) => {
    const { key } = req.params as { key: string };
    const patch = PatchRegistrant.parse(req.body);
    return mutate(
      { action: 'patch_registrant', target: key, payload: patch },
      (s) => {
        const cur = s.registrants[key] ?? { club: '', present: false, paid: false, paidAmount: 0 };
        s.registrants[key] = { ...cur, ...patch };
        return s;
      },
    );
  });

  app.patch('/api/participants/:id', async (req) => {
    const { id } = req.params as { id: string };
    const patch = PatchParticipant.parse(req.body);
    return mutate(
      { action: 'patch_participant', target: id, payload: patch },
      (s) => {
        const p = s.participants.find(p => p.id === id);
        if (!p) throw new Error(`participant ${id} not found`);
        if (patch.category !== undefined) p.category = patch.category;
        if (patch.class !== undefined) p.class = patch.class;
        if (patch.withdrawn !== undefined) p.withdrawn = patch.withdrawn;
        if (patch.players) {
          // Positional rename: carry the old name's registrant (check-in/fee) to
          // the new name if the new one has none yet. Then apply club edits.
          patch.players.forEach((pl, i) => {
            const oldName = p.players[i];
            if (oldName && key(oldName) !== key(pl.name) && s.registrants[key(oldName)] && !s.registrants[key(pl.name)]) {
              s.registrants[key(pl.name)] = { ...s.registrants[key(oldName)] };
            }
            setRegistrantClub(s, pl.name, pl.club);
          });
          p.players = patch.players.map(pl => pl.name);
        }
        return s;
      },
    );
  });

  // Pair two unpaired doubles entries of the same category + class into one team
  // (`a` absorbs `b`'s player; `b`'s row is removed). Per-person data persists in
  // registrants (keyed by name), so nothing is lost.
  app.post('/api/participants/:id/pair', async (req) => {
    const { id } = req.params as { id: string };
    const { partnerId } = Pair.parse(req.body);
    return mutate(
      { action: 'pair_participants', target: id, payload: { partnerId } },
      (s) => {
        const a = s.participants.find(p => p.id === id);
        const b = s.participants.find(p => p.id === partnerId);
        if (!a || !b) throw new Error('participant not found');
        if (a.id === b.id) throw new Error('cannot pair a participant with itself');
        if (a.category !== b.category || a.class !== b.class) throw new Error('partners must share category and class');
        if (a.players.length !== 1 || b.players.length !== 1) throw new Error('both participants must be unpaired');
        a.players = [a.players[0], b.players[0]];
        s.participants = s.participants.filter(p => p.id !== b.id);
        s.groups.forEach(g => { g.members = g.members.filter(m => m !== b.id); });
        return s;
      },
    );
  });

  // Split a paired team back into two solo entries (the second player becomes a
  // fresh partnerless participant in the same category + class).
  app.post('/api/participants/:id/unpair', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(
      { action: 'unpair_participant', target: id },
      (s) => {
        const p = s.participants.find(x => x.id === id);
        if (!p) throw new Error(`participant ${id} not found`);
        if (p.players.length < 2) throw new Error('participant is not a paired team');
        const partnerName = p.players.pop()!;
        s.participants.push({
          id: nanoid(8), withdrawn: false,
          category: p.category, class: p.class, players: [partnerName],
        });
        return s;
      },
    );
  });

  app.delete('/api/participants/:id', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(
      { action: 'remove_participant', target: id },
      (s) => {
        s.participants = s.participants.filter(p => p.id !== id);
        s.groups.forEach(g => { g.members = g.members.filter(m => m !== id); });
        return s;
      },
    );
  });

  // Bulk delete by explicit id list. The UI builds the list from a chosen
  // filter (category, category+class, all, or all "missing partner" entries).
  // Doing the filter client-side keeps this endpoint simple and lets the
  // confirm dialog match exactly what gets removed.
  const BulkDelete = z.object({ ids: z.array(z.string().min(1)).min(1) });
  app.post('/api/participants/bulk-delete', async (req) => {
    const { ids } = BulkDelete.parse(req.body);
    const set = new Set(ids);
    return mutate(
      { action: 'bulk_remove_participants', payload: { count: ids.length } },
      (s) => {
        s.participants = s.participants.filter(p => !set.has(p.id));
        s.groups.forEach(g => { g.members = g.members.filter(m => !set.has(m)); });
        return s;
      },
    );
  });

  // Withdraw a participant: flip the flag, then cascade walkovers across every
  // unfinished group match they're in and their next active KO slot. Played
  // matches stay as-is. Reinstate only clears the flag — walkover history is
  // left in place because it's now real match data (use the per-match Undo
  // walkover action in Scoring/Bracket to revert a specific result).
  app.post('/api/participants/:id/withdraw', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(
      { action: 'withdraw_participant', target: id },
      (s) => {
        const p = s.participants.find(p => p.id === id);
        if (!p) throw new Error(`participant ${id} not found`);
        p.withdrawn = true;
        const now = new Date().toISOString();

        for (const g of s.groups) {
          if (!g.members.includes(id)) continue;
          for (const r of g.rounds) {
            for (const m of r.matches) {
              if (m.status === 'done') continue;
              if (m.p1 !== id && m.p2 !== id) continue;
              const opp = m.p1 === id ? m.p2 : m.p1;
              if (opp === '__bye__') continue;
              m.walkover = m.p1 === id ? 'p2' : 'p1';
              m.score = [];
              m.status = 'done';
              if (!m.finishedAt) m.finishedAt = now;
            }
          }
        }

        for (const kb of s.knockouts) {
          for (const round of kb.rounds) {
            const slot = round.slots.find(sl =>
              (sl.p1 === id || sl.p2 === id) &&
              sl.status !== 'done' &&
              sl.winner !== id
            );
            if (!slot) continue;
            const oppSide = slot.p1 === id ? 'p2' : 'p1';
            const oppId = oppSide === 'p1' ? slot.p1 : slot.p2;
            if (!oppId) break;
            slot.walkover = oppSide;
            slot.score = [];
            slot.status = 'done';
            slot.winner = oppId;
            if (!slot.finishedAt) slot.finishedAt = now;
            propagateBracketWinner(kb, round.roundNo, slot.slot, oppId);
            break;
          }
        }

        return s;
      },
    );
  });

  app.post('/api/participants/:id/reinstate', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(
      { action: 'reinstate_participant', target: id },
      (s) => {
        const p = s.participants.find(p => p.id === id);
        if (!p) throw new Error(`participant ${id} not found`);
        p.withdrawn = false;
        return s;
      },
    );
  });

  app.post('/api/participants/import-csv', async (req) => {
    const { csv } = req.body as { csv?: string };
    if (!csv) throw new Error('csv required');
    const rows = parseCsv(csv, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
    return mutate(
      { action: 'import_csv', payload: { count: rows.length } },
      (s) => {
        for (const row of rows) {
          const name = row.name ?? row.Name ?? '';
          if (!name) continue;
          const club = row.club ?? row.Club ?? '';
          const players = name.includes(' & ')
            ? name.split('&').map(s => s.trim()).filter(Boolean)
            : [name.trim()];
          if (!players.length) continue;
          s.participants.push({
            id: nanoid(8),
            withdrawn: false,
            category: row.category ?? row.Category ?? '',
            class: row.class ?? row.Class ?? '',
            players,
          });
          for (const pn of players) setRegistrantClub(s, pn, club);
        }
        return s;
      },
    );
  });
}
