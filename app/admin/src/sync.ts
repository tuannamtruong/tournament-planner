// Multi-laptop sync: keep a single canonical tournament.json in S3 in step with
// this laptop's local copy, using S3 conditional writes (If-Match / ETag) for
// optimistic concurrency — no always-on backend, so it stays within the event's
// cost budget. The flow each tick (and best-effort after every local edit):
//
//   1. pull the canonical object (+ its ETag)
//   2. merge(base, local, remote) — 3-way, per-record (see merge.ts)
//   3. write the merged result locally (via withState, serialized with edits)
//   4. push it back with If-Match: <pulled ETag>; on 412 someone else wrote in
//      between, so loop and try again.
//
// `base` is the last state we successfully synced, persisted next to
// tournament.json so add-vs-delete survives a restart. Offline (pull/push throw
// a network error) is non-fatal: we keep editing locally and retry next tick.

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Tournament, type Tournament as T } from './schema.ts';
import { merge, type Conflict } from './merge.ts';
import { load, withState, dataFilePath } from './storage.ts';
import { NODE_ID } from './rev.ts';

const BUCKET = process.env.TP_BUCKET ?? '';
const REGION = process.env.TP_REGION ?? 'eu-central-1';
const STATE_KEY = process.env.TP_STATE_KEY ?? 'private/state/tournament.json';
// Local alternative to S3: point every laptop at one shared folder (e.g. a LAN
// share). Implements the same If-Match/ETag semantics so the whole multi-laptop
// flow runs — and is tested — without AWS. Takes precedence over TP_BUCKET.
const SYNC_DIR = process.env.TP_SYNC_DIR ?? '';
const SYNC_INTERVAL_MS = Number(process.env.TP_SYNC_INTERVAL_MS ?? 3000);
const BASE_FILE = path.join(path.dirname(dataFilePath()), 'sync-base.json');

export type SyncStatus = {
  enabled: boolean;       // TP_BUCKET set?
  nodeId: string;
  online: boolean;        // last pull/push reached S3
  lastSyncAt: string | null;
  lastError: string | null;
  conflicts: Conflict[];  // unacknowledged conflicts for the operator
};

const status: SyncStatus = {
  enabled: !!BUCKET || !!SYNC_DIR,
  nodeId: NODE_ID,
  online: false,
  lastSyncAt: null,
  lastError: null,
  conflicts: [],
};

export function getSyncStatus(): SyncStatus {
  return { ...status, conflicts: [...status.conflicts] };
}

export function ackConflicts(): void {
  status.conflicts = [];
}

// -- Pluggable store (real S3 in prod, in-memory fake in tests) ---------------

export class PreconditionFailed extends Error {
  constructor() { super('precondition failed (remote changed)'); this.name = 'PreconditionFailed'; }
}

export interface SyncStore {
  // null = the canonical object doesn't exist yet (first ever sync).
  pull(): Promise<{ state: T; etag: string } | null>;
  // ifMatchEtag null => create-only (If-None-Match: *). Throws PreconditionFailed on 412.
  push(state: T, ifMatchEtag: string | null): Promise<{ etag: string }>;
}

export class S3Store implements SyncStore {
  private s3 = new S3Client({ region: REGION });

  async pull() {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: STATE_KEY }));
      const body = await res.Body!.transformToString();
      return { state: Tournament.parse(JSON.parse(body)), etag: res.ETag ?? '' };
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return null;
      const code = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (code === 404) return null;
      throw err;
    }
  }

  async push(state: T, ifMatchEtag: string | null) {
    try {
      const res = await this.s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: STATE_KEY,
        Body: JSON.stringify(state),
        ContentType: 'application/json; charset=utf-8',
        CacheControl: 'no-store',
        ...(ifMatchEtag ? { IfMatch: ifMatchEtag } : { IfNoneMatch: '*' }),
      }));
      return { etag: res.ETag ?? '' };
    } catch (err) {
      const code = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const name = (err as { name?: string }).name;
      if (code === 412 || code === 409 || name === 'PreconditionFailed') throw new PreconditionFailed();
      throw err;
    }
  }
}

// Shared-folder store with the same conditional-write contract as S3. ETag is a
// content hash; push checks it before overwriting (a small TOCTOU window — fine
// for a LAN share / local dev, where edits are seconds apart). Primary use is
// running + testing the multi-laptop flow without AWS.
export class FilesystemStore implements SyncStore {
  private file: string;
  constructor(dir: string) { this.file = path.join(dir, 'tournament.json'); }

  private async readRaw(): Promise<string | null> {
    try { return await fs.readFile(this.file, 'utf8'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
  }

  async pull() {
    const raw = await this.readRaw();
    if (raw === null) return null;
    return { state: Tournament.parse(JSON.parse(raw)), etag: hash(raw) };
  }

  async push(state: T, ifMatchEtag: string | null) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const raw = await this.readRaw();
    const currentEtag = raw === null ? null : hash(raw);
    // create-only (null) must find nothing; overwrite must match the pulled etag.
    if (ifMatchEtag === null ? currentEtag !== null : currentEtag !== ifMatchEtag) {
      throw new PreconditionFailed();
    }
    const body = JSON.stringify(state);
    const tmp = this.file + '.' + process.pid + '.tmp';
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, this.file);
    return { etag: hash(body) };
  }
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32);
}

// -- Base (last-synced) snapshot persistence ---------------------------------

let baseState: T | null = null;
let lastEtag: string | null = null;

async function loadBase(): Promise<T | null> {
  if (baseState) return baseState;
  try {
    const raw = await fs.readFile(BASE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { etag: string | null; state: unknown };
    baseState = Tournament.parse(parsed.state);
    lastEtag = parsed.etag;
  } catch { /* no base yet */ }
  return baseState;
}

async function saveBase(state: T, etag: string | null): Promise<void> {
  baseState = state;
  lastEtag = etag;
  const tmp = BASE_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify({ etag, state }));
  await fs.rename(tmp, BASE_FILE);
}

// -- Sync engine --------------------------------------------------------------

let store: SyncStore | null = null;
let running = false;
let timer: NodeJS.Timeout | null = null;

/** One full pull→merge→push cycle. Safe to call concurrently (guarded). */
export async function syncOnce(): Promise<void> {
  if (!store || running) return;
  running = true;
  try {
    await loadBase();
    // Retry the merge/push loop a few times if the remote keeps moving under us.
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await store.pull();

      if (!remote) {
        // First ever sync: create the object from our local state.
        const local = await load();
        try {
          const { etag } = await store.push(local, null);
          await saveBase(local, etag);
        } catch (err) {
          if (err instanceof PreconditionFailed) continue; // someone created it; re-pull
          throw err;
        }
        break;
      }

      // Merge remote into the latest local state (serialized with local edits),
      // collecting conflicts and writing the merged result locally.
      const { merged, conflicts, changedLocally } = await withState(async (local) => {
        const r = merge(baseState, local, remote.state);
        // Skip the local write when nothing actually changed, to avoid bumping
        // rev (and the clients' poll) on every idle tick.
        const sameAsLocal = JSON.stringify(stripVolatile(r.merged)) === JSON.stringify(stripVolatile(local));
        return {
          next: sameAsLocal ? undefined : r.merged,
          result: { merged: sameAsLocal ? local : r.merged, conflicts: r.conflicts, changedLocally: !sameAsLocal },
        };
      });
      if (conflicts.length) status.conflicts = dedupeConflicts([...status.conflicts, ...conflicts]);

      // Push if our merged result differs from what's in S3 (we changed it, or
      // we had unpushed local edits). If the remote already equals merged, just
      // record the base.
      const mergedEqualsRemote = JSON.stringify(stripVolatile(merged)) === JSON.stringify(stripVolatile(remote.state));
      if (mergedEqualsRemote && !changedLocally) {
        await saveBase(remote.state, remote.etag);
        break;
      }
      try {
        const { etag } = await store.push(merged, remote.etag);
        await saveBase(merged, etag);
        break;
      } catch (err) {
        if (err instanceof PreconditionFailed) continue; // remote moved; re-pull + re-merge
        throw err;
      }
    }
    status.online = true;
    status.lastError = null;
    status.lastSyncAt = new Date().toISOString();
  } catch (err) {
    // Network/credential failure → stay offline, keep local edits, retry later.
    status.online = false;
    status.lastError = err instanceof Error ? err.message : String(err);
  } finally {
    running = false;
  }
}

// Ignore `rev`/`updatedAt` churn when deciding whether two states are
// meaningfully equal (merge() always bumps the global rev).
function stripVolatile(t: T): unknown {
  return { ...t, rev: 0, tournament: { ...t.tournament, updatedAt: '' } };
}

function dedupeConflicts(list: Conflict[]): Conflict[] {
  const seen = new Set<string>();
  const out: Conflict[] = [];
  for (const c of list) {
    const k = `${c.kind}:${c.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/**
 * Start the background sync loop. No-op unless a store is configured: an
 * explicit `customStore`, else TP_SYNC_DIR (shared folder), else TP_BUCKET (S3).
 */
export function startSync(customStore?: SyncStore): void {
  store = customStore ?? (SYNC_DIR ? new FilesystemStore(SYNC_DIR) : BUCKET ? new S3Store() : null);
  if (!store) return;
  if (timer) return;
  void syncOnce();
  timer = setInterval(() => void syncOnce(), SYNC_INTERVAL_MS);
  timer.unref();
}

/** Nudge a sync soon after a local edit (best-effort, debounced by syncOnce's guard). */
export function nudgeSync(): void {
  if (store) void syncOnce();
}
