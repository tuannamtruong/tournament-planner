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
};

const status: PublishStatus = {
  configured: !!BUCKET,
  lastSuccess: null,
  lastError: null,
  pendingChanges: 0,
  inFlight: false,
};

export function getStatus(): PublishStatus {
  return { ...status };
}

/**
 * Mark state as dirty. The actual push is manual — the operator clicks
 * "Force publish" (or "Push backup snapshot") when ready. We still count
 * pending changes so the UI can show how many edits are unpushed.
 */
export function schedulePublish(): void {
  status.pendingChanges++;
}

/**
 * Push immediately (the "Force publish" button). Returns when the push
 * attempt finishes (success or thrown error). No automatic retries.
 */
export async function forcePush(): Promise<void> {
  if (!BUCKET) throw new Error('TP_BUCKET not set — cannot push.');
  await runPublish();
}

async function runPublish(): Promise<void> {
  if (!BUCKET) return;
  if (status.inFlight) return;
  status.inFlight = true;
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
  } catch (err) {
    status.lastError = err instanceof Error ? err.message : String(err);
    throw err;
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
 * Triggered manually by the "Push backup snapshot" button.
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
