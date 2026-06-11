import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { parse as parseCsv } from 'csv-parse/sync';
import { z } from 'zod';
import { mutate } from '../storage.ts';

const NewParticipant = z.object({
  name: z.string().min(1),
  club: z.string().default(''),
  category: z.string().default(''),
  class: z.string().default(''),
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
