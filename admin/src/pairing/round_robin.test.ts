import { describe, expect, it } from 'vitest';
import { roundRobin } from './round_robin.ts';

describe('roundRobin', () => {
  it('returns empty schedule for <2 players', () => {
    expect(roundRobin([])).toEqual([]);
    expect(roundRobin(['a'])).toEqual([]);
  });

  it('produces N-1 rounds for even N and pairs each player against every other exactly once', () => {
    const players = ['a', 'b', 'c', 'd', 'e', 'f'];
    const schedule = roundRobin(players);
    expect(schedule).toHaveLength(5);

    const seen = new Set<string>();
    for (const round of schedule) {
      const playedThisRound = new Set<string>();
      for (const { p1, p2 } of round.pairs) {
        expect(p2).not.toBeNull();
        // Each player appears at most once per round
        expect(playedThisRound.has(p1)).toBe(false);
        expect(playedThisRound.has(p2!)).toBe(false);
        playedThisRound.add(p1); playedThisRound.add(p2!);
        // No duplicate pairings across the whole schedule
        const key = [p1, p2!].sort().join(':');
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      expect(playedThisRound.size).toBe(players.length);
    }
    // Total unique pairings = C(6, 2) = 15
    expect(seen.size).toBe(15);
  });

  it('produces N rounds for odd N with exactly one bye per round and one bye per player', () => {
    const players = ['a', 'b', 'c', 'd', 'e'];
    const schedule = roundRobin(players);
    expect(schedule).toHaveLength(5);

    const byes: string[] = [];
    for (const round of schedule) {
      const byesThisRound = round.pairs.filter(p => p.p2 === null);
      expect(byesThisRound).toHaveLength(1);
      byes.push(byesThisRound[0].p1);
    }
    expect(new Set(byes).size).toBe(players.length);
  });

  it('is deterministic', () => {
    const a = roundRobin(['a', 'b', 'c', 'd']);
    const b = roundRobin(['a', 'b', 'c', 'd']);
    expect(a).toEqual(b);
  });
});
