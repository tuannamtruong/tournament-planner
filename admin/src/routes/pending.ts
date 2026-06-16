import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPendingView, pendingCount } from '../pending.ts';
import { restoreFromPending } from '../storage.ts';
import { refreshPendingCount } from '../publish.ts';

const RevertBody = z.union([
  z.object({ mode: z.literal('all') }),
  z.object({ index: z.number().int().nonnegative() }),
]);

export async function pendingRoutes(app: FastifyInstance) {
  app.get('/api/pending', async () => {
    return getPendingView();
  });

  app.post('/api/pending/revert', async (req) => {
    const body = RevertBody.parse(req.body);
    const total = await pendingCount();
    if (total === 0) throw new Error('no pending changes to revert');
    const index = 'mode' in body ? 0 : body.index;
    if (index >= total) throw new Error(`pending index ${index} out of range (have ${total})`);
    const state = await restoreFromPending(index);
    await refreshPendingCount();
    return state;
  });
}
