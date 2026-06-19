import { describe, expect, it } from 'vitest';
import { swissPairings, type SwissPlayer } from './swiss.ts';

const player = (id: string, points = 0, opponents: string[] = [], hadBye = false): SwissPlayer => ({
  id, points, opponents: new Set(opponents), hadBye,
});

describe('swissPairings', () => {
  it('pairs top with next-best when no prior matches', () => {
    const result = swissPairings([
      player('a', 3), player('b', 3), player('c', 2), player('d', 1),
    ]);
    expect(result.bye).toBeNull();
    expect(result.pairs).toHaveLength(2);
    expect(result.pairs[0]).toEqual({ p1: 'a', p2: 'b' });
    expect(result.pairs[1]).toEqual({ p1: 'c', p2: 'd' });
  });

  it('avoids rematches', () => {
    const result = swissPairings([
      player('a', 3, ['b']),
      player('b', 3, ['a']),
      player('c', 2),
      player('d', 1),
    ]);
    const pairKeys = result.pairs.map(p => [p.p1, p.p2].sort().join(':'));
    expect(pairKeys).not.toContain('a:b');
  });

  it('gives bye to the lowest-ranked unbyed player on odd counts', () => {
    const result = swissPairings([
      player('a', 3), player('b', 2), player('c', 1, [], true), player('d', 1), player('e', 0),
    ]);
    expect(result.bye).toBe('e');
    expect(result.pairs).toHaveLength(2);
  });

  it('falls back to lowest-ranked player when everyone has had a bye', () => {
    const result = swissPairings([
      player('a', 2, [], true),
      player('b', 1, [], true),
      player('c', 0, [], true),
    ]);
    expect(result.bye).toBe('c');
  });

  it('throws when no rematch-free pairing exists', () => {
    expect(() => swissPairings([
      player('a', 0, ['b']),
      player('b', 0, ['a']),
    ])).toThrow(/no rematch-free/);
  });
});
