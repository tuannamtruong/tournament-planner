import { describe, expect, it } from 'vitest';
import { generateNextRound } from './index.ts';
import type { Group } from '../schema.ts';

describe('generateNextRound — withdrawal handling', () => {
  it('excludes withdrawn members from round-robin pairings', () => {
    const group: Group = {
      id: 'g', name: 'G', mode: 'round_robin',
      category: '', classes: [],
      members: ['a', 'b', 'c', 'd'],
      rounds: [],
    };
    const round = generateNextRound(group, new Set(['c']));
    const ids = round.matches.flatMap(m => [m.p1, m.p2]);
    expect(ids).not.toContain('c');
    // 3 remaining players → round-robin first round has 1 pair + 1 bye.
    expect(round.matches).toHaveLength(2);
  });

  it('keeps walkover history as opponents-played for Swiss anti-rematch', () => {
    const group: Group = {
      id: 'g', name: 'G', mode: 'swiss',
      category: '', classes: [],
      members: ['a', 'b', 'c', 'd'],
      rounds: [{
        roundNo: 1,
        matches: [
          // 'a' beat 'b' by walkover, 'c' beat 'd' for real.
          { id: 'm1', p1: 'a', p2: 'b', court: '', score: [], status: 'done', walkover: 'p1', startedAt: null, finishedAt: null },
          { id: 'm2', p1: 'c', p2: 'd', court: '', score: [[21, 10], [21, 10]], status: 'done', walkover: null, startedAt: null, finishedAt: null },
        ],
      }],
    };
    // 'b' is now withdrawn; remaining pool: a, c, d. 'a' and 'c' both have 1 point.
    const round = generateNextRound(group, new Set(['b']));
    const ids = round.matches.flatMap(m => [m.p1, m.p2]);
    expect(ids).not.toContain('b');
    // 3 players → one pair + one bye.
    const real = round.matches.filter(m => m.p2 !== '__bye__');
    expect(real).toHaveLength(1);
    // Whoever the pair is, it must not be a rematch of a previous walkover.
    const pairKey = [real[0].p1, real[0].p2].sort().join(':');
    expect(pairKey).not.toBe('a:b');
  });
});
