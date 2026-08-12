// Cross-laptop reconciliation for multi-operator editing.
//
// Each laptop edits its own copy and syncs through a single canonical
// tournament.json in S3 (see sync.ts). When two laptops have both moved on from
// the last-synced state we must combine their changes per-record, never
// clobbering, and flag the rare true conflicts for the operator.
//
// This is a 3-WAY merge: base (the last state this laptop synced) + local
// (ours now) + remote (just pulled). The base is what lets us tell an ADD from
// a DELETE — with only local+remote, an id present on one side is ambiguous.
//
// Change detection uses the per-record `rev` counter (touch() bumps it on every
// edit): a record changed iff its rev differs from the base's rev (or it's
// absent from base). True conflicts (both sides changed the same record) are
// resolved last-write-wins by `updatedAt`, and reported so the UI can notify.

import {
  type Tournament, type Participant, type Registrant, type Group, type Bracket,
  type Round, type BracketRound, type Match, type BracketSlot,
} from './schema.ts';

export type ConflictKind =
  | 'participant' | 'registrant' | 'group' | 'match' | 'bracket' | 'slot'
  | 'scoring' | 'tournament';

export type Conflict = {
  kind: ConflictKind;
  id: string;            // record id / map key / "kid r/s" path
  label: string;         // short human description for the toast
  winner: 'local' | 'remote';
  localEditor: string;
  remoteEditor: string;
};

export type MergeResult = { merged: Tournament; conflicts: Conflict[] };

type Rev = { rev?: number; updatedAt?: string; lastEditor?: string };
const revOf = (r: Rev | undefined) => (r?.rev ?? 0);
const editorOf = (r: Rev | undefined) => (r?.lastEditor ?? '');
// Changed vs base = rev moved, or the record didn't exist in base (an add).
const changed = (rec: Rev, base: Rev | undefined) => !base || revOf(rec) !== revOf(base);
// LWW tiebreak for a true conflict: newer updatedAt wins; ties favour remote so
// every laptop converges on the same choice.
function localWins(local: Rev, remote: Rev): boolean {
  return (local.updatedAt ?? '') > (remote.updatedAt ?? '');
}

// Merge one leaf record present in both local and remote. Returns the chosen
// value and, when both sides changed it, a conflict descriptor.
function mergeLeaf<T extends Rev>(
  base: T | undefined, local: T, remote: T,
): { value: T; conflict: 'local' | 'remote' | null } {
  const lc = changed(local, base);
  const rc = changed(remote, base);
  if (lc && rc) {
    if (revOf(local) === revOf(remote) && (local.updatedAt ?? '') === (remote.updatedAt ?? '')) {
      return { value: local, conflict: null }; // identical concurrent edit — no real conflict
    }
    return localWins(local, remote) ? { value: local, conflict: 'local' } : { value: remote, conflict: 'remote' };
  }
  if (lc) return { value: local, conflict: null };
  if (rc) return { value: remote, conflict: null };
  return { value: local, conflict: null }; // neither changed
}

// Generic 3-way merge of an id-keyed collection. `mergeOne` combines a record
// present on both sides (leaf or composite). Deletions: a record in base that's
// gone from one side is dropped unless the other side edited it (edit-vs-delete
// → keep the edit, flag). Additions (absent from base) are always kept.
function mergeCollection<T extends Rev>(
  base: T[], local: T[], remote: T[],
  idOf: (t: T) => string,
  mergeOne: (b: T | undefined, l: T, r: T) => { value: T; conflicts: Conflict[] },
  onDeleteConflict: (kept: T) => Conflict,
): { values: T[]; conflicts: Conflict[] } {
  const bMap = new Map(base.map(t => [idOf(t), t]));
  const lMap = new Map(local.map(t => [idOf(t), t]));
  const rMap = new Map(remote.map(t => [idOf(t), t]));
  const conflicts: Conflict[] = [];
  const out: T[] = [];
  // Local order first, then remote-only additions, so output is stable.
  const ids: string[] = [...lMap.keys()];
  for (const id of rMap.keys()) if (!lMap.has(id)) ids.push(id);

  for (const id of ids) {
    const b = bMap.get(id), l = lMap.get(id), r = rMap.get(id);
    if (l && r) {
      const res = mergeOne(b, l, r);
      out.push(res.value);
      conflicts.push(...res.conflicts);
    } else if (l && !r) {
      if (!b) { out.push(l); }                      // added locally
      else if (changed(l, b)) { out.push(l); conflicts.push(onDeleteConflict(l)); } // edit vs remote-delete
      // else: deleted remotely, untouched locally → drop
    } else if (!l && r) {
      if (!b) { out.push(r); }                       // added remotely
      else if (changed(r, b)) { out.push(r); conflicts.push(onDeleteConflict(r)); } // edit vs local-delete
      // else: deleted locally, untouched remotely → drop
    }
  }
  return { values: out, conflicts };
}

// -- Rounds / matches & slots -------------------------------------------------

function mergeRounds(base: Round[], local: Round[], remote: Round[], groupName: string): { rounds: Round[]; conflicts: Conflict[] } {
  const byNo = (rs: Round[]) => new Map(rs.map(r => [r.roundNo, r]));
  const bM = byNo(base), lM = byNo(local), rM = byNo(remote);
  const nos = new Set<number>([...lM.keys(), ...rM.keys()]);
  const conflicts: Conflict[] = [];
  const rounds: Round[] = [];
  for (const no of [...nos].sort((a, b) => a - b)) {
    const lr = lM.get(no), rr = rM.get(no);
    if (lr && !rr) { rounds.push(lr); continue; }
    if (rr && !lr) { rounds.push(rr); continue; }
    const res = mergeCollection<Match>(
      bM.get(no)?.matches ?? [], lr!.matches, rr!.matches,
      m => m.id,
      (b, l, r) => {
        const { value, conflict } = mergeLeaf(b, l, r);
        return {
          value,
          conflicts: conflict ? [{
            kind: 'match', id: l.id, winner: conflict,
            label: `${groupName} R${no}: ${l.p1} vs ${l.p2}`,
            localEditor: editorOf(l), remoteEditor: editorOf(r),
          }] : [],
        };
      },
      kept => ({ kind: 'match', id: kept.id, winner: 'local',
        label: `${groupName} R${no} match kept (deleted on the other laptop)`,
        localEditor: editorOf(kept), remoteEditor: '' }),
    );
    conflicts.push(...res.conflicts);
    rounds.push({ roundNo: no, matches: res.values });
  }
  return { rounds, conflicts };
}

function mergeSlots(base: BracketSlot[], local: BracketSlot[], remote: BracketSlot[], bracketName: string, roundNo: number): { slots: BracketSlot[]; conflicts: Conflict[] } {
  const res = mergeCollection<BracketSlot>(
    base, local, remote,
    s => String(s.slot),
    (b, l, r) => {
      const { value, conflict } = mergeLeaf(b, l, r);
      return {
        value,
        conflicts: conflict ? [{
          kind: 'slot', id: `${bracketName} r${roundNo}s${l.slot}`, winner: conflict,
          label: `${bracketName} R${roundNo} slot ${l.slot}`,
          localEditor: editorOf(l), remoteEditor: editorOf(r),
        }] : [],
      };
    },
    kept => ({ kind: 'slot', id: `r${roundNo}s${kept.slot}`, winner: 'local',
      label: `${bracketName} R${roundNo} slot kept (deleted on the other laptop)`,
      localEditor: editorOf(kept), remoteEditor: '' }),
  );
  return { slots: res.values.sort((a, b) => a.slot - b.slot), conflicts: res.conflicts };
}

// -- Groups & brackets (composite: identity by rev, children descended) -------

function mergeGroupOne(base: Group | undefined, local: Group, remote: Group): { value: Group; conflicts: Conflict[] } {
  // Identity fields (name/mode/category/classes/members/pointSystemId) merge by
  // the group's own rev; rounds/matches are merged independently so two
  // operators scoring different matches in one group both survive.
  const idy = mergeLeaf(base, local, remote);
  const conflicts: Conflict[] = [];
  if (idy.conflict) conflicts.push({
    kind: 'group', id: local.id, winner: idy.conflict,
    label: `Group "${local.name}" settings`,
    localEditor: editorOf(local), remoteEditor: editorOf(remote),
  });
  const r = mergeRounds(base?.rounds ?? [], local.rounds, remote.rounds, local.name);
  conflicts.push(...r.conflicts);
  return { value: { ...idy.value, rounds: r.rounds }, conflicts };
}

function mergeBracketOne(base: Bracket | undefined, local: Bracket, remote: Bracket): { value: Bracket; conflicts: Conflict[] } {
  const idy = mergeLeaf(base, local, remote);
  const conflicts: Conflict[] = [];
  if (idy.conflict) conflicts.push({
    kind: 'bracket', id: local.id, winner: idy.conflict,
    label: `Bracket "${local.name}" settings`,
    localEditor: editorOf(local), remoteEditor: editorOf(remote),
  });
  const byNo = (rs: BracketRound[]) => new Map(rs.map(r => [r.roundNo, r]));
  const bM = byNo(base?.rounds ?? []), lM = byNo(local.rounds), rM = byNo(remote.rounds);
  const nos = new Set<number>([...lM.keys(), ...rM.keys()]);
  const rounds: BracketRound[] = [];
  for (const no of [...nos].sort((a, b) => a - b)) {
    const lr = lM.get(no), rr = rM.get(no);
    if (lr && !rr) { rounds.push(lr); continue; }
    if (rr && !lr) { rounds.push(rr); continue; }
    const m = mergeSlots(bM.get(no)?.slots ?? [], lr!.slots, rr!.slots, local.name, no);
    conflicts.push(...m.conflicts);
    // Round name: keep local unless only remote diverged from base.
    const baseName = bM.get(no)?.name;
    const name = lr!.name !== baseName ? lr!.name : rr!.name;
    rounds.push({ roundNo: no, name, slots: m.slots });
  }
  return { value: { ...idy.value, rounds }, conflicts };
}

// -- Registrants (name-keyed map) --------------------------------------------

function mergeRegistrants(base: Record<string, Registrant>, local: Record<string, Registrant>, remote: Record<string, Registrant>): { value: Record<string, Registrant>; conflicts: Conflict[] } {
  const toArr = (m: Record<string, Registrant>) => Object.entries(m).map(([k, v]) => ({ ...v, __key: k }));
  type R = Registrant & { __key: string };
  const res = mergeCollection<R>(
    toArr(base), toArr(local), toArr(remote),
    r => r.__key,
    (b, l, r) => {
      const { value, conflict } = mergeLeaf(b, l, r);
      return {
        value,
        conflicts: conflict ? [{
          kind: 'registrant', id: l.__key, winner: conflict,
          label: `Check-in/fee for "${l.__key}"`,
          localEditor: editorOf(l), remoteEditor: editorOf(r),
        }] : [],
      };
    },
    kept => ({ kind: 'registrant', id: kept.__key, winner: 'local',
      label: `Check-in/fee for "${kept.__key}" kept`,
      localEditor: editorOf(kept), remoteEditor: '' }),
  );
  const out: Record<string, Registrant> = {};
  for (const r of res.values) { const { __key, ...rest } = r; out[__key] = rest; }
  return { value: out, conflicts: res.conflicts };
}

export function merge(base: Tournament | null, local: Tournament, remote: Tournament): MergeResult {
  const b = base ?? ({ participants: [], registrants: {}, groups: [], knockouts: [] } as unknown as Tournament);
  const conflicts: Conflict[] = [];

  const participants = mergeCollection<Participant>(
    b.participants ?? [], local.participants, remote.participants,
    p => p.id,
    (bp, l, r) => {
      const { value, conflict } = mergeLeaf(bp, l, r);
      return {
        value,
        conflicts: conflict ? [{
          kind: 'participant', id: l.id, winner: conflict,
          label: `Participant "${l.players.join(' & ')}"`,
          localEditor: editorOf(l), remoteEditor: editorOf(r),
        }] : [],
      };
    },
    kept => ({ kind: 'participant', id: kept.id, winner: 'local',
      label: `Participant "${kept.players.join(' & ')}" kept (deleted on the other laptop)`,
      localEditor: editorOf(kept), remoteEditor: '' }),
  );
  conflicts.push(...participants.conflicts);

  const registrants = mergeRegistrants(b.registrants ?? {}, local.registrants, remote.registrants);
  conflicts.push(...registrants.conflicts);

  const groups = mergeCollection<Group>(
    b.groups ?? [], local.groups, remote.groups, g => g.id, mergeGroupOne,
    kept => ({ kind: 'group', id: kept.id, winner: 'local',
      label: `Group "${kept.name}" kept (deleted on the other laptop)`,
      localEditor: editorOf(kept), remoteEditor: '' }),
  );
  conflicts.push(...groups.conflicts);

  const knockouts = mergeCollection<Bracket>(
    b.knockouts ?? [], local.knockouts, remote.knockouts, k => k.id, mergeBracketOne,
    kept => ({ kind: 'bracket', id: kept.id, winner: 'local',
      label: `Bracket "${kept.name}" kept (deleted on the other laptop)`,
      localEditor: editorOf(kept), remoteEditor: '' }),
  );
  conflicts.push(...knockouts.conflicts);

  // Tournament name + scoring have no per-record rev; LWW by tournament.updatedAt.
  const remoteNewer = (remote.tournament.updatedAt ?? '') > (local.tournament.updatedAt ?? '');
  const tournament = remoteNewer ? remote.tournament : local.tournament;
  const scoring = remoteNewer ? remote.scoring : local.scoring;

  const merged: Tournament = {
    tournament,
    rev: Math.max(local.rev ?? 0, remote.rev ?? 0) + 1,
    participants: participants.values,
    registrants: registrants.value,
    scoring,
    groups: groups.values,
    knockouts: knockouts.values,
    auditLog: local.auditLog ?? [],
  };
  return { merged, conflicts };
}
