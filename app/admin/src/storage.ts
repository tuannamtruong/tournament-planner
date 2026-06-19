import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Tournament, emptyTournament, type Tournament as TournamentT, type AuditEntry } from './schema.ts';
import { appendPending, getSnapshot, truncatePending } from './pending.ts';

const DATA_FILE = process.env.TP_DATA_FILE
  ? path.resolve(process.env.TP_DATA_FILE)
  : path.resolve('admin/data/tournament.json');
const BACKUP_DIR = path.join(path.dirname(DATA_FILE), 'backups');

let cache: TournamentT | null = null;
let writeChain: Promise<void> = Promise.resolve();

export async function load(): Promise<TournamentT> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    cache = Tournament.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = emptyTournament();
      await writeAtomic(cache);
    } else {
      throw err;
    }
  }
  return cache;
}

async function writeAtomic(state: TournamentT): Promise<void> {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, DATA_FILE);
}

type Mutator = (state: TournamentT) => TournamentT | Promise<TournamentT>;

/**
 * Apply a mutation atomically. Serializes concurrent calls. The mutation
 * receives a deep clone so it can mutate freely; the result is validated and
 * written via temp-file + rename. Returns the new state.
 */
export async function mutate(
  audit: Omit<AuditEntry, 'ts' | 'target'> & { target?: string },
  fn: Mutator,
): Promise<TournamentT> {
  const result = writeChain.then(async () => {
    const current = await load();
    const preMutation = structuredClone(current);
    const draft: TournamentT = structuredClone(current);
    const next = await fn(draft);
    const ts = new Date().toISOString();
    next.tournament.updatedAt = ts;
    next.auditLog.push({ ts, target: '', ...audit });
    if (next.auditLog.length > 5000) next.auditLog.splice(0, next.auditLog.length - 5000);
    const validated = Tournament.parse(next);
    await writeAtomic(validated);
    cache = validated;
    try {
      await appendPending(preMutation, { ts, action: audit.action, target: audit.target, payload: audit.payload });
    } catch (err) {
      // Pending log is best-effort: a failure here doesn't roll back the main
      // write. Operator loses the per-change undo for this mutation only.
      console.error('[pending] append failed', err);
    }
    return validated;
  });
  writeChain = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Linear-undo: replace the live state with the snapshot recorded immediately
 * before the pending entry at `index`, then truncate the pending log so that
 * entries [index, end) are discarded. Goes through the same writeChain as
 * mutate() so it can't race with concurrent edits.
 */
export async function restoreFromPending(index: number): Promise<TournamentT> {
  const result = writeChain.then(async () => {
    const restored = await getSnapshot(index);
    const validated = Tournament.parse(restored);
    await writeAtomic(validated);
    cache = validated;
    await truncatePending(index);
    return validated;
  });
  writeChain = result.then(() => undefined, () => undefined);
  return result;
}

let snapshotTimer: NodeJS.Timeout | null = null;
const SNAPSHOT_KEEP = 50;
const SNAPSHOT_INTERVAL_MS = 5 * 60_000;

export function startLocalSnapshots(intervalMs = SNAPSHOT_INTERVAL_MS): void {
  if (snapshotTimer) return;
  const tick = async () => {
    try {
      const state = await load();
      await fs.mkdir(BACKUP_DIR, { recursive: true });
      const fn = `tournament-${Date.now()}.json`;
      await fs.writeFile(path.join(BACKUP_DIR, fn), JSON.stringify(state, null, 2));
      const files = (await fs.readdir(BACKUP_DIR))
        .filter(f => f.startsWith('tournament-'))
        .sort();
      while (files.length > SNAPSHOT_KEEP) {
        const oldest = files.shift()!;
        await fs.unlink(path.join(BACKUP_DIR, oldest)).catch(() => {});
      }
    } catch (err) {
      console.error('[snapshot] failed', err);
    }
  };
  snapshotTimer = setInterval(tick, intervalMs);
  snapshotTimer.unref();
}

export function dataFilePath(): string {
  return DATA_FILE;
}
