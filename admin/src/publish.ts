import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { load } from './storage.ts';
import { computeStandings } from './standings.ts';
import { clearPending, loadPending } from './pending.ts';
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
 * pendingChanges is the authoritative count of unpushed mutations. It's
 * derived from the on-disk pending log so it survives a server restart.
 * Called from the publish-status route; cheap because the log is cached.
 */
export async function refreshPendingCount(): Promise<void> {
  const log = await loadPending();
  status.pendingChanges = log.entries.length;
}

/**
 * Push immediately (the "Publish" button). Returns when the push
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
    await clearPending();
    status.pendingChanges = 0;
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

function seedOf(state: Tournament, id: string | null): number | null {
  if (!id || id === '__bye__') return null;
  const p = state.participants.find(p => p.id === id);
  return p && p.seed > 0 ? p.seed : null;
}

export function deriveViews(state: Tournament) {
  const groups = state.groups.map(g => ({
    id: g.id,
    name: g.name,
    mode: g.mode,
    category: g.category,
    classes: g.classes,
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
        walkover: m.walkover,
      })),
    })),
  }));

  const brackets = state.knockouts.map(kb => ({
    id: kb.id,
    name: kb.name,
    category: kb.category,
    classes: kb.classes,
    size: kb.size,
    rounds: kb.rounds.map(r => ({
      roundNo: r.roundNo,
      name: r.name,
      slots: r.slots.map(s => ({
        slot: s.slot,
        p1: s.p1 ? nameOf(state, s.p1) : null,
        p2: s.p2 ? nameOf(state, s.p2) : null,
        p1Seed: seedOf(state, s.p1),
        p2Seed: seedOf(state, s.p2),
        court: s.court,
        score: s.score,
        status: s.status,
        walkover: s.walkover,
        winner: s.winner ? nameOf(state, s.winner) : null,
      })),
    })),
  }));

  return {
    version: { updatedAt: state.tournament.updatedAt, name: state.tournament.name },
    groups: { tournament: state.tournament.name, groups },
    knockout: { tournament: state.tournament.name, brackets },
  };
}
