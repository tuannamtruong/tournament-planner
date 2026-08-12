import type { FastifyInstance } from 'fastify';
import { getSyncStatus, ackConflicts, syncOnce } from '../sync.ts';

export async function syncRoutes(app: FastifyInstance) {
  // Live multi-laptop sync state for the header light + conflict toasts.
  app.get('/api/sync/status', async () => getSyncStatus());
  // Manual "sync now" (e.g. just after the venue Wi-Fi comes back).
  app.post('/api/sync/now', async () => { await syncOnce(); return getSyncStatus(); });
  // Operator dismisses the conflict notifications once they've reviewed them.
  app.post('/api/sync/conflicts/ack', async () => { ackConflicts(); return getSyncStatus(); });
}
