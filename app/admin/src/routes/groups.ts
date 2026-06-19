import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { mutate } from '../storage.ts';
import { GroupMode } from '../schema.ts';
import { generateNextRound } from '../pairing/index.ts';

const NewGroup = z.object({
  name: z.string().min(1),
  mode: GroupMode,
  category: z.string().min(1),
  classes: z.array(z.string()).min(1),
  members: z.array(z.string()).default([]),
});

export async function groupRoutes(app: FastifyInstance) {
  app.post('/api/groups', async (req) => {
    const g = NewGroup.parse(req.body);
    return mutate(
      { action: 'create_group', payload: g },
      (s) => {
        s.groups.push({ id: nanoid(6), rounds: [], ...g });
        return s;
      },
    );
  });

  app.patch('/api/groups/:id', async (req) => {
    const { id } = req.params as { id: string };
    const patch = NewGroup.partial().parse(req.body);
    return mutate(
      { action: 'patch_group', target: id, payload: patch },
      (s) => {
        const g = s.groups.find(g => g.id === id);
        if (!g) throw new Error(`group ${id} not found`);
        Object.assign(g, patch);
        return s;
      },
    );
  });

  app.delete('/api/groups/:id', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(
      { action: 'delete_group', target: id },
      (s) => { s.groups = s.groups.filter(g => g.id !== id); return s; },
    );
  });

  app.post('/api/groups/:id/next-round', async (req) => {
    const { id } = req.params as { id: string };
    return mutate(
      { action: 'generate_round', target: id },
      (s) => {
        const g = s.groups.find(g => g.id === id);
        if (!g) throw new Error(`group ${id} not found`);
        const withdrawn = new Set(s.participants.filter(p => p.withdrawn).map(p => p.id));
        const round = generateNextRound(g, withdrawn);
        g.rounds.push(round);
        return s;
      },
    );
  });
}
