import { describe, it, expect } from 'vitest';
import { merge } from './merge.ts';
import { Tournament, type Tournament as T } from './schema.ts';

function base(): T {
  return Tournament.parse({
    tournament: { id: 'tp', name: 'T', updatedAt: '2026-01-01T00:00:00.000Z' },
    rev: 1,
    participants: [
      { id: 'p1', players: ['Alice'], category: 'WS', class: 'A', rev: 0, updatedAt: '', lastEditor: '' },
      { id: 'p2', players: ['Bob'], category: 'WS', class: 'A', rev: 0, updatedAt: '', lastEditor: '' },
    ],
    groups: [{
      id: 'g1', name: 'Group A', mode: 'round_robin', category: 'WS', classes: ['A'], members: ['p1', 'p2'],
      rounds: [{ roundNo: 1, matches: [
        { id: 'm1', p1: 'p1', p2: 'p2', court: '', score: [], status: 'pending', walkover: null, startedAt: null, finishedAt: null, rev: 0 },
        { id: 'm2', p1: 'p2', p2: 'p1', court: '', score: [], status: 'pending', walkover: null, startedAt: null, finishedAt: null, rev: 0 },
      ] }],
    }],
  });
}

const clone = (t: T): T => structuredClone(t);
function editMatch(t: T, mid: string, score: number[][], editor: string, at: string) {
  const m = t.groups[0].rounds[0].matches.find(x => x.id === mid)!;
  m.score = score as [number, number][];
  m.status = 'done';
  m.rev = (m.rev ?? 0) + 1;
  m.updatedAt = at;
  m.lastEditor = editor;
}

describe('merge', () => {
  it('takes the locally-changed record when remote is unchanged', () => {
    const b = base(), local = clone(b), remote = clone(b);
    editMatch(local, 'm1', [[21, 10]], 'laptopA', '2026-01-02T00:00:00Z');
    const { merged, conflicts } = merge(b, local, remote);
    expect(conflicts).toHaveLength(0);
    expect(merged.groups[0].rounds[0].matches.find(m => m.id === 'm1')!.score).toEqual([[21, 10]]);
  });

  it('takes the remotely-changed record when local is unchanged', () => {
    const b = base(), local = clone(b), remote = clone(b);
    editMatch(remote, 'm1', [[21, 5]], 'laptopB', '2026-01-02T00:00:00Z');
    const { merged, conflicts } = merge(b, local, remote);
    expect(conflicts).toHaveLength(0);
    expect(merged.groups[0].rounds[0].matches.find(m => m.id === 'm1')!.score).toEqual([[21, 5]]);
  });

  it('merges disjoint edits to different matches without conflict', () => {
    const b = base(), local = clone(b), remote = clone(b);
    editMatch(local, 'm1', [[21, 10]], 'laptopA', '2026-01-02T00:00:00Z');
    editMatch(remote, 'm2', [[15, 21]], 'laptopB', '2026-01-02T00:01:00Z');
    const { merged, conflicts } = merge(b, local, remote);
    expect(conflicts).toHaveLength(0);
    const ms = merged.groups[0].rounds[0].matches;
    expect(ms.find(m => m.id === 'm1')!.score).toEqual([[21, 10]]);
    expect(ms.find(m => m.id === 'm2')!.score).toEqual([[15, 21]]);
  });

  it('flags a same-record conflict and resolves last-write-wins by updatedAt', () => {
    const b = base(), local = clone(b), remote = clone(b);
    editMatch(local, 'm1', [[21, 10]], 'laptopA', '2026-01-02T00:00:00Z');   // earlier
    editMatch(remote, 'm1', [[21, 19]], 'laptopB', '2026-01-02T00:05:00Z');  // later → wins
    const { merged, conflicts } = merge(b, local, remote);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('match');
    expect(conflicts[0].winner).toBe('remote');
    expect(merged.groups[0].rounds[0].matches.find(m => m.id === 'm1')!.score).toEqual([[21, 19]]);
  });

  it('keeps an addition made on only one side', () => {
    const b = base(), local = clone(b), remote = clone(b);
    local.participants.push({ id: 'p3', players: ['Cara'], category: 'WS', class: 'A', withdrawn: false } as any);
    const { merged, conflicts } = merge(b, local, remote);
    expect(conflicts).toHaveLength(0);
    expect(merged.participants.map(p => p.id).sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('honours a delete when the other side did not touch the record', () => {
    const b = base(), local = clone(b), remote = clone(b);
    remote.participants = remote.participants.filter(p => p.id !== 'p2'); // deleted remotely
    const { merged, conflicts } = merge(b, local, remote);
    expect(conflicts).toHaveLength(0);
    expect(merged.participants.map(p => p.id)).toEqual(['p1']);
  });

  it('keeps an edited record over a delete and flags it (edit-vs-delete)', () => {
    const b = base(), local = clone(b), remote = clone(b);
    const p = local.participants.find(x => x.id === 'p2')!;
    p.class = 'B'; p.rev = 1; p.updatedAt = '2026-01-02T00:00:00Z'; p.lastEditor = 'laptopA';
    remote.participants = remote.participants.filter(x => x.id !== 'p2'); // deleted remotely
    const { merged, conflicts } = merge(b, local, remote);
    expect(merged.participants.map(p => p.id).sort()).toEqual(['p1', 'p2']);
    expect(conflicts.some(c => c.kind === 'participant')).toBe(true);
  });

  it('bumps the global rev above both inputs', () => {
    const b = base(), local = clone(b), remote = clone(b);
    local.rev = 5; remote.rev = 8;
    const { merged } = merge(b, local, remote);
    expect(merged.rev).toBe(9);
  });

  it('treats a null base as all-additions (first sync)', () => {
    const local = base();
    const remote = clone(local);
    remote.participants.push({ id: 'pX', players: ['Zed'], category: 'MS', class: 'A', withdrawn: false } as any);
    const { merged, conflicts } = merge(null, local, remote);
    expect(conflicts).toHaveLength(0);
    expect(merged.participants.map(p => p.id)).toContain('pX');
  });
});
