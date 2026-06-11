import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Tournament, emptyTournament, type Tournament as TournamentT, type AuditEntry } from './schema.ts';

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
export async function mutate(audit: Omit<AuditEntry, 'ts'>, fn: Mutator): Promise<TournamentT> {
  const result = writeChain.then(async () => {
    const current = await load();
    const draft: TournamentT = structuredClone(current);
    const next = await fn(draft);
    next.tournament.updatedAt = new Date().toISOString();
    next.auditLog.push({ ts: next.tournament.updatedAt, ...audit });
    if (next.auditLog.length > 5000) next.auditLog.splice(0, next.auditLog.length - 5000);
    const validated = Tournament.parse(next);
    await writeAtomic(validated);
    cache = validated;
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
