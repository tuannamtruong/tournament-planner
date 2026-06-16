import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { parse as parseCsv } from 'csv-parse/sync';
import { z } from 'zod';
import { mutate } from '../storage.ts';
import { propagate as propagateBracketWinner } from './knockout.ts';

const NewParticipant = z.object({
  name: z.string().min(1),
  club: z.string().default(''),
  category: z.string().min(1),
  class: z.string().min(1),
  seed: z.number().int().nonnegative().default(0),
});

const PatchParticipant = NewParticipant.partial().extend({
  withdrawn: z.boolean().optional(),
});

export async function participantRoutes(app: FastifyInstance) {
  app.post('/api/participants', async (req) => {
    const p = NewParticipant.parse(req.body);
    return mutate(
      { action: 'add_participant', payload: p },
      (s) => {
        s.participants.push({ id: nanoid(8), withdrawn: false, ...p });
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
        Object.assign(p, patch);
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
          s.participants.push({
            id: nanoid(8),
            name,
            club: row.club ?? row.Club ?? '',
            category: row.category ?? row.Category ?? '',
            class: row.class ?? row.Class ?? '',
            seed: Number(row.seed ?? row.Seed ?? 0) || 0,
            withdrawn: false,
          });
        }
        return s;
      },
    );
  });
}
