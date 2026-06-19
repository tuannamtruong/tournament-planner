import type { FastifyInstance } from 'fastify';
import { load, mutate } from '../storage.ts';

export async function stateRoutes(app: FastifyInstance) {
  app.get('/api/state', async () => {
    return load();
  });

  app.put('/api/state/name', async (req) => {
    const body = req.body as { name?: string };
    if (!body?.name) throw new Error('name required');
    return mutate(
      { action: 'rename_tournament', payload: { name: body.name } },
      (s) => { s.tournament.name = body.name!; return s; },
    );
  });
}
