import { promises as fs } from 'node:fs';
import path from 'node:path';
import { displayName, type Tournament, type Participant, type Group, type Bracket, type Match } from './schema.ts';

const DATA_FILE = process.env.TP_DATA_FILE
  ? path.resolve(process.env.TP_DATA_FILE)
  : path.resolve('admin/data/tournament.json');
const PENDING_FILE = path.join(path.dirname(DATA_FILE), 'pending.json');

export type PendingEntry = {
  ts: string;
  action: string;
  target: string;
  payload?: unknown;
  snapshot: Tournament;
};

export type PendingLog = {
  baselineAt: string | null;
  entries: PendingEntry[];
};

let cache: PendingLog | null = null;

export async function loadPending(): Promise<PendingLog> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(PENDING_FILE, 'utf8');
    const parsed = JSON.parse(raw) as PendingLog;
    cache = { baselineAt: parsed.baselineAt ?? null, entries: parsed.entries ?? [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = { baselineAt: null, entries: [] };
    } else {
      throw err;
    }
  }
  return cache;
}

async function writeAtomic(log: PendingLog): Promise<void> {
  await fs.mkdir(path.dirname(PENDING_FILE), { recursive: true });
  const tmp = PENDING_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(log));
  await fs.rename(tmp, PENDING_FILE);
  cache = log;
}

export async function appendPending(
  snapshot: Tournament,
  audit: { ts: string; action: string; target?: string; payload?: unknown },
): Promise<void> {
  const log = await loadPending();
  log.entries.push({
    ts: audit.ts,
    action: audit.action,
    target: audit.target ?? '',
    payload: audit.payload,
    snapshot,
  });
  await writeAtomic(log);
}

export async function clearPending(): Promise<void> {
  await writeAtomic({ baselineAt: new Date().toISOString(), entries: [] });
}

export async function truncatePending(index: number): Promise<void> {
  const log = await loadPending();
  log.entries = log.entries.slice(0, Math.max(0, index));
  await writeAtomic(log);
}

export async function getSnapshot(index: number): Promise<Tournament> {
  const log = await loadPending();
  if (index < 0 || index >= log.entries.length) {
    throw new Error(`pending index ${index} out of range (0..${log.entries.length - 1})`);
  }
  return log.entries[index].snapshot;
}

export async function pendingCount(): Promise<number> {
  const log = await loadPending();
  return log.entries.length;
}

type Tab = 'participants' | 'groups' | 'matches' | 'bracket' | 'settings';

type PendingEntryView = {
  index: number;
  ts: string;
  action: string;
  target: string;
  tab: Tab;
  summary: string;
};

export async function getPendingView(): Promise<{
  baselineAt: string | null;
  entries: PendingEntryView[];
}> {
  const log = await loadPending();
  return {
    baselineAt: log.baselineAt,
    entries: log.entries.map((e, index) => {
      const { tab, summary } = describeEntry(e);
      return { index, ts: e.ts, action: e.action, target: e.target, tab, summary };
    }),
  };
}

// -- Description formatter ---------------------------------------------------
// Resolves IDs against the pre-mutation snapshot (which captures the state the
// operator saw at the moment they made the change) so the summary stays
// accurate even if later changes delete the referenced entity.

function findParticipant(state: Tournament, id: string | null | undefined): Participant | null {
  if (!id) return null;
  return state.participants.find(p => p.id === id) ?? null;
}

function findGroup(state: Tournament, id: string): Group | null {
  return state.groups.find(g => g.id === id) ?? null;
}

function findBracket(state: Tournament, id: string): Bracket | null {
  return state.knockouts.find(b => b.id === id) ?? null;
}

function findMatch(state: Tournament, mid: string): { group: Group; roundNo: number; match: Match } | null {
  for (const g of state.groups) {
    for (const r of g.rounds) {
      const m = r.matches.find(m => m.id === mid);
      if (m) return { group: g, roundNo: r.roundNo, match: m };
    }
  }
  return null;
}

function participantTag(p: Participant | null, fallback = '?'): string {
  if (!p) return fallback;
  const cls = p.class ? `/${p.class}` : '';
  const cat = p.category || '?';
  return `"${displayName(p)}" (${cat}${cls})`;
}

function participantName(p: Participant | null, fallback = '?'): string {
  return p ? displayName(p) : fallback;
}

function groupTag(g: Group | null, fallback = '?'): string {
  if (!g) return fallback;
  const cls = g.classes.length ? `/${g.classes.join('+')}` : '';
  return `"${g.name}" (${g.category || '?'}${cls})`;
}

function bracketTag(b: Bracket | null, fallback = '?'): string {
  if (!b) return fallback;
  const cls = b.classes.length ? `/${b.classes.join('+')}` : '';
  return `"${b.name}" (${b.category || '?'}${cls})`;
}

function scoreString(score: ReadonlyArray<readonly [number, number]>): string {
  return score.map(([a, b]) => `${a}–${b}`).join(', ');
}

function describeEntry(entry: PendingEntry): { tab: Tab; summary: string } {
  const snap = entry.snapshot;
  const payload = (entry.payload ?? {}) as Record<string, unknown>;
  const target = entry.target || '';

  switch (entry.action) {
    case 'rename_tournament':
      return { tab: 'settings', summary: `Renamed tournament to "${payload.name ?? ''}"` };

    case 'add_participant': {
      const cat = (payload.category as string) || '?';
      const cls = payload.class ? `/${payload.class}` : '';
      const players = Array.isArray(payload.players)
        ? (payload.players as Array<{ name?: string }>).map(pl => pl?.name ?? '').filter(Boolean).join(' & ')
        : '';
      return { tab: 'participants', summary: `Added "${players}" (${cat}${cls})` };
    }
    case 'patch_participant': {
      const p = findParticipant(snap, target);
      const fields = Object.keys(payload).join(', ');
      return { tab: 'participants', summary: `Edited ${participantTag(p, target)}${fields ? ` — ${fields}` : ''}` };
    }
    case 'patch_registrant': {
      const fields = Object.keys(payload).join(', ');
      return { tab: 'participants', summary: `Updated check-in/fee for "${target}"${fields ? ` — ${fields}` : ''}` };
    }
    case 'remove_participant':
      return { tab: 'participants', summary: `Removed ${participantTag(findParticipant(snap, target), target)}` };
    case 'withdraw_participant':
      return { tab: 'participants', summary: `Withdrew ${participantTag(findParticipant(snap, target), target)}` };
    case 'reinstate_participant':
      return { tab: 'participants', summary: `Reinstated ${participantTag(findParticipant(snap, target), target)}` };
    case 'pair_participants': {
      const a = findParticipant(snap, target);
      const b = findParticipant(snap, (payload.partnerId as string) ?? '');
      return { tab: 'participants', summary: `Paired ${participantName(a, target)} with ${participantName(b, '?')}` };
    }
    case 'unpair_participant':
      return { tab: 'participants', summary: `Unpaired ${participantTag(findParticipant(snap, target), target)}` };
    case 'bulk_remove_participants':
      return { tab: 'participants', summary: `Bulk-deleted ${payload.count ?? '?'} participants` };
    case 'import_csv':
      return { tab: 'participants', summary: `Imported ${payload.count ?? '?'} participants from CSV` };

    case 'create_group': {
      const cls = Array.isArray(payload.classes) ? (payload.classes as string[]).join('+') : '';
      const cat = (payload.category as string) || '?';
      return { tab: 'groups', summary: `Created group "${payload.name ?? ''}" (${cat}${cls ? '/' + cls : ''}, ${payload.mode ?? '?'})` };
    }
    case 'patch_group':
      return { tab: 'groups', summary: `Edited group ${groupTag(findGroup(snap, target), target)}` };
    case 'delete_group':
      return { tab: 'groups', summary: `Deleted group ${groupTag(findGroup(snap, target), target)}` };
    case 'generate_round': {
      const g = findGroup(snap, target);
      const next = (g?.rounds.length ?? 0) + 1;
      return { tab: 'groups', summary: `Generated round ${next} in ${groupTag(g, target)}` };
    }

    case 'patch_match': {
      const found = findMatch(snap, target);
      if (!found) return { tab: 'matches', summary: `Edited match ${target}` };
      const { group, roundNo, match } = found;
      const p1 = participantName(findParticipant(snap, match.p1), match.p1);
      const p2 = match.p2 === '__bye__' ? 'BYE' : participantName(findParticipant(snap, match.p2), match.p2);
      const parts: string[] = [];
      if (payload.status !== undefined) parts.push(`status→${payload.status}`);
      if (payload.score !== undefined) parts.push(`score ${scoreString(payload.score as [number, number][])}`);
      if (payload.court !== undefined) parts.push(`court→${payload.court || '—'}`);
      if (payload.walkover !== undefined) parts.push(`walkover→${payload.walkover ?? 'cleared'}`);
      return { tab: 'matches', summary: `${groupTag(group)} R${roundNo}: ${p1} vs ${p2}${parts.length ? ' — ' + parts.join(', ') : ''}` };
    }
    case 'delete_match': {
      const found = findMatch(snap, target);
      if (!found) return { tab: 'matches', summary: `Deleted match ${target}` };
      const { group, roundNo, match } = found;
      const p1 = participantName(findParticipant(snap, match.p1), match.p1);
      const p2 = match.p2 === '__bye__' ? 'BYE' : participantName(findParticipant(snap, match.p2), match.p2);
      return { tab: 'matches', summary: `Deleted ${groupTag(group)} R${roundNo}: ${p1} vs ${p2}` };
    }
    case 'add_manual_match': {
      const g = findGroup(snap, target);
      const p1 = participantName(findParticipant(snap, payload.p1 as string), String(payload.p1 ?? '?'));
      const p2 = participantName(findParticipant(snap, payload.p2 as string), String(payload.p2 ?? '?'));
      return { tab: 'matches', summary: `Added match in ${groupTag(g, target)} R${payload.roundNo ?? '?'}: ${p1} vs ${p2}` };
    }

    case 'create_bracket': {
      const cls = Array.isArray(payload.classes) ? (payload.classes as string[]).join('+') : '';
      const cat = (payload.category as string) || '?';
      const slots = payload.slotCount ?? payload.size;
      return { tab: 'bracket', summary: `Created bracket "${payload.name ?? ''}" (${cat}${cls ? '/' + cls : ''}, ${slots} slots)` };
    }
    case 'rename_round': {
      const [kid] = target.split('/');
      return { tab: 'bracket', summary: `Renamed round in ${bracketTag(findBracket(snap, kid), kid)} → "${payload.name ?? ''}"` };
    }
    case 'patch_slot': {
      const [kid, rs] = target.split('/');
      const m = rs?.match(/r(\d+)s(\d+)/);
      const roundNo = m ? Number(m[1]) : null;
      const slotNo = m ? Number(m[2]) : null;
      const b = findBracket(snap, kid);
      const round = roundNo != null ? b?.rounds.find(r => r.roundNo === roundNo) : undefined;
      const slot = slotNo != null ? round?.slots.find(s => s.slot === slotNo) : undefined;
      const p1 = slot?.p1 ? participantName(findParticipant(snap, slot.p1), slot.p1) : 'TBD';
      const p2 = slot?.p2 ? participantName(findParticipant(snap, slot.p2), slot.p2) : 'TBD';
      const parts: string[] = [];
      if (payload.status !== undefined) parts.push(`status→${payload.status}`);
      if (payload.score !== undefined) parts.push(`score ${scoreString(payload.score as [number, number][])}`);
      if (payload.winner !== undefined) {
        const w = payload.winner ? participantName(findParticipant(snap, payload.winner as string), String(payload.winner)) : 'cleared';
        parts.push(`winner→${w}`);
      }
      if (payload.walkover !== undefined) parts.push(`walkover→${payload.walkover ?? 'cleared'}`);
      const roundLabel = round?.name || (roundNo ? `R${roundNo}` : '?');
      return { tab: 'bracket', summary: `${bracketTag(b, kid)} ${roundLabel}: ${p1} vs ${p2}${parts.length ? ' — ' + parts.join(', ') : ''}` };
    }
    case 'delete_bracket':
      return { tab: 'bracket', summary: `Deleted bracket ${bracketTag(findBracket(snap, target), target)}` };

    default:
      return { tab: 'settings', summary: `${entry.action}${target ? ` (${target})` : ''}` };
  }
}

export function pendingFilePath(): string {
  return PENDING_FILE;
}
