import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { load, mutate } from '../storage.ts';
import { Scoring } from '../schema.ts';

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

  // Replace the point-system library + default (Settings tab). The client sends
  // the whole library; we guarantee every system has a unique id and that
  // defaultId resolves (falling back to the first system) so downstream lookups
  // never dangle. Groups/brackets referencing a since-deleted system fall back
  // to the default at scoring time.
  app.put('/api/state/scoring', async (req) => {
    const scoring = Scoring.parse(req.body);
    const seen = new Set<string>();
    for (const sys of scoring.systems) {
      if (!sys.id || seen.has(sys.id)) sys.id = nanoid(8);
      seen.add(sys.id);
    }
    if (!scoring.systems.some(s => s.id === scoring.defaultId)) {
      scoring.defaultId = scoring.systems[0].id;
    }
    return mutate(
      { action: 'update_scoring', payload: scoring },
      (s) => { s.scoring = scoring; return s; },
    );
  });
}
