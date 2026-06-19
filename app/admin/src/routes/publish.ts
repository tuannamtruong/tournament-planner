import type { FastifyInstance } from 'fastify';
import { forcePush, getStatus, pushBackup, refreshPendingCount } from '../publish.ts';

export async function publishRoutes(app: FastifyInstance) {
  app.get('/api/publish/status', async () => {
    await refreshPendingCount();
    return getStatus();
  });

  app.post('/api/publish/force', async (_req, reply) => {
    try {
      await forcePush();
      return { ok: true, status: getStatus() };
    } catch (err) {
      reply.code(502);
      return { ok: false, error: err instanceof Error ? err.message : String(err), status: getStatus() };
    }
  });

  app.post('/api/publish/backup', async (_req, reply) => {
    try {
      await pushBackup();
      return { ok: true };
    } catch (err) {
      reply.code(502);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
