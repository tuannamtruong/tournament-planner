import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { load } from './storage.ts';
import { computeStandings } from './standings.ts';
import type { Tournament } from './schema.ts';

const BUCKET = process.env.TP_BUCKET ?? '';
const REGION = process.env.TP_REGION ?? 'eu-central-1';

let s3: S3Client | null = null;
function client(): S3Client {
  if (!s3) s3 = new S3Client({ region: REGION });
  return s3;
}

export type PublishStatus = {
  configured: boolean;       // is TP_BUCKET set?
  lastSuccess: string | null;
  lastError: string | null;
  pendingChanges: number;    // changes since last successful push
  inFlight: boolean;
  nextRetryAt: string | null;
};

const status: PublishStatus = {
  configured: !!BUCKET,
  lastSuccess: null,
  lastError: null,
  pendingChanges: 0,
  inFlight: false,
  nextRetryAt: null,
};

export function getStatus(): PublishStatus {
  return { ...status };
}

let debounceTimer: NodeJS.Timeout | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let backoffMs = 1000;
const MAX_BACKOFF = 60_000;
const DEBOUNCE_MS = 500;

/**
 * Mark state as dirty and schedule a debounced push. Safe to call on every
 * mutation; multiple calls within the debounce window coalesce into one push.
 *
 * If TP_BUCKET is not set (e.g. local dev with no AWS), this counts pending
 * changes but never pushes — the UI shows "AWS not configured".
 */
export function schedulePublish(): void {
  status.pendingChanges++;
  if (!BUCKET) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runPublish, DEBOUNCE_MS);
}

/**
 * Force an immediate push (manual "Force Publish" button). Cancels any pending
 * debounce. Returns when the push attempt finishes (success or thrown error).
 */
export async function forcePush(): Promise<void> {
  if (!BUCKET) throw new Error('TP_BUCKET not set — cannot push.');
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  await runPublish(true);
}

async function runPublish(rethrow = false): Promise<void> {
  if (!BUCKET) return;
  if (status.inFlight) return;
  status.inFlight = true;
  status.nextRetryAt = null;
  const pendingAtStart = status.pendingChanges;
  try {
    const state = await load();
    const views = deriveViews(state);
    await Promise.all([
      putJson('data/version.json', views.version, 5),
      putJson('data/groups.json', views.groups, 15),
      putJson('data/knockout.json', views.knockout, 15),
    ]);
    status.lastSuccess = new Date().toISOString();
    status.lastError = null;
    status.pendingChanges = Math.max(0, status.pendingChanges - pendingAtStart);
    backoffMs = 1000;
  } catch (err) {
    status.lastError = err instanceof Error ? err.message : String(err);
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
    status.nextRetryAt = new Date(Date.now() + wait).toISOString();
    retryTimer = setTimeout(() => { runPublish().catch(() => {}); }, wait);
    if (rethrow) throw err;
  } finally {
    status.inFlight = false;
  }
}

async function putJson(key: string, value: unknown, maxAgeSec: number): Promise<void> {
  await client().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(value),
    ContentType: 'application/json; charset=utf-8',
    CacheControl: `public, max-age=${maxAgeSec}`,
  }));
}

/**
 * Push a full snapshot of the local tournament.json to s3://$BUCKET/private/backups/.
 * Called by the hourly backup timer.
 */
export async function pushBackup(): Promise<void> {
  if (!BUCKET) return;
  const state = await load();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await client().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `private/backups/tournament-${ts}.json`,
    Body: JSON.stringify(state, null, 2),
    ContentType: 'application/json; charset=utf-8',
    CacheControl: 'no-store',
  }));
}

let backupTimer: NodeJS.Timeout | null = null;
export function startRemoteBackups(intervalMs = 60 * 60_000): void {
  if (backupTimer || !BUCKET) return;
  backupTimer = setInterval(() => { pushBackup().catch(err => console.error('[backup]', err)); }, intervalMs);
  backupTimer.unref();
}

// -- View derivation ----------------------------------------------------------

function nameOf(state: Tournament, id: string): string {
  if (id === '__bye__') return 'BYE';
  return state.participants.find(p => p.id === id)?.name ?? id;
}

export function deriveViews(state: Tournament) {
  const groups = state.groups.map(g => ({
    id: g.id,
    name: g.name,
    mode: g.mode,
    members: g.members.map(id => ({ id, name: nameOf(state, id) })),
    standings: computeStandings(g, state.participants),
    rounds: g.rounds.map(r => ({
      roundNo: r.roundNo,
      matches: r.matches.map(m => ({
        id: m.id,
        p1: nameOf(state, m.p1),
        p2: nameOf(state, m.p2),
        court: m.court,
        score: m.score,
        status: m.status,
      })),
    })),
  }));

  const knockout = state.knockout ? {
    size: state.knockout.size,
    rounds: state.knockout.rounds.map(r => ({
      roundNo: r.roundNo,
      slots: r.slots.map(s => ({
        slot: s.slot,
        p1: s.p1 ? nameOf(state, s.p1) : null,
        p2: s.p2 ? nameOf(state, s.p2) : null,
        score: s.score,
        winner: s.winner ? nameOf(state, s.winner) : null,
      })),
    })),
  } : null;

  return {
    version: { updatedAt: state.tournament.updatedAt, name: state.tournament.name },
    groups: { tournament: state.tournament.name, groups },
    knockout,
  };
}
