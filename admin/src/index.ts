import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { startLocalSnapshots, dataFilePath, load } from './storage.ts';
import { schedulePublish, getStatus, deriveViews } from './publish.ts';
import { stateRoutes } from './routes/state.ts';
import { participantRoutes } from './routes/participants.ts';
import { groupRoutes } from './routes/groups.ts';
import { matchRoutes } from './routes/matches.ts';
import { knockoutRoutes } from './routes/knockout.ts';
import { publishRoutes } from './routes/publish.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_DIR = path.resolve(__dirname, '../public');
const RESULT_DIR = path.resolve(__dirname, '../../result-site');

const app = Fastify({
  logger: true,
  bodyLimit: 2 * 1024 * 1024,  // 2 MB — generous for CSV pastes
});

const FIELD_LABEL: Record<string, string> = {
  category: 'Category',
  classes: 'Classes',
  name: 'Name',
  mode: 'Mode',
  size: 'Size',
  seeds: 'Seeds',
  members: 'Members',
};

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) {
    const parts = err.errors.map((e) => {
      const field = e.path.length ? String(e.path[0]) : 'request';
      const label = FIELD_LABEL[field] ?? field;
      if (e.code === 'too_small') {
        if (e.type === 'string') return `${label} is required.`;
        if (e.type === 'array') return `${label}: pick at least ${e.minimum}.`;
        return `${label}: must be at least ${e.minimum}.`;
      }
      return `${label}: ${e.message}`;
    });
    return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: parts.join(' ') });
  }
  reply.send(err);
});

await app.register(fastifyStatic, { root: ADMIN_DIR, prefix: '/' });
await app.register(fastifyStatic, { root: RESULT_DIR, prefix: '/view', redirect: true, decorateReply: false });

// Live preview of the result site: same HTML/JS that gets uploaded to S3,
// served same-origin from this Fastify so the relative `data/*.json` fetches
// hit the dynamic route below. Lets the operator verify exactly what
// spectators will see without provisioning S3.
const VIEW_FILES: Record<string, { maxAge: number; pick: (v: ReturnType<typeof deriveViews>) => unknown }> = {
  'version.json':  { maxAge: 5,  pick: (v) => v.version },
  'groups.json':   { maxAge: 15, pick: (v) => v.groups },
  'knockout.json': { maxAge: 15, pick: (v) => v.knockout },
};
app.get('/view/data/:file', async (req, reply) => {
  const { file } = req.params as { file: string };
  const spec = VIEW_FILES[file];
  if (!spec) return reply.code(404).send({ error: 'not found' });
  const views = deriveViews(await load());
  return reply
    .header('Cache-Control', `public, max-age=${spec.maxAge}`)
    .type('application/json; charset=utf-8')
    .send(spec.pick(views));
});

// Mark state as dirty after every successful state-changing API call so the UI
// can show the pending-changes count. The actual push to S3 is manual — the
// operator clicks "Publish" when they want to publish.
app.addHook('onResponse', async (req, reply) => {
  if (reply.statusCode >= 400) return;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  if (!req.url.startsWith('/api/')) return;
  if (req.url.startsWith('/api/publish')) return;
  schedulePublish();
});

await app.register(stateRoutes);
await app.register(participantRoutes);
await app.register(groupRoutes);
await app.register(matchRoutes);
await app.register(knockoutRoutes);
await app.register(publishRoutes);

startLocalSnapshots();

const port = Number(process.env.PORT ?? 37325);
await app.listen({ port, host: '127.0.0.1' });

const status = getStatus();
app.log.info({ dataFile: dataFilePath(), publish: status }, 'tournament admin ready');
app.log.info(`admin  →  http://localhost:${port}`);
app.log.info(`viewer →  http://localhost:${port}/view/`);
if (!status.configured) {
  app.log.warn('TP_BUCKET not set — running in local-only mode (no S3 push).');
}
