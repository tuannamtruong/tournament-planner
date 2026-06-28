import { describe, expect, it } from 'vitest';
import { computeStandings } from './standings.ts';
import type { Group, Participant } from './schema.ts';

const part = (id: string, name: string): Participant => ({
  id, name, club: '', category: '', class: '', withdrawn: false,
});

const match = (
  id: string, p1: string, p2: string,
  score: [number, number][],
) => ({
  id, p1, p2, court: '', score,
  status: 'done' as const, walkover: null, startedAt: null, finishedAt: null,
});

const walkoverMatch = (
  id: string, p1: string, p2: string, winner: 'p1' | 'p2',
) => ({
  id, p1, p2, court: '', score: [] as [number, number][],
  status: 'done' as const, walkover: winner, startedAt: null, finishedAt: null,
});

describe('computeStandings', () => {
  it('ranks by match wins first', () => {
    const participants = ['a', 'b', 'c'].map(id => part(id, id.toUpperCase()));
    const group: Group = {
      id: 'g', name: 'G', category: '', classes: [], mode: 'round_robin',
      members: ['a', 'b', 'c'],
      rounds: [{
        roundNo: 1,
        matches: [
          match('m1', 'a', 'b', [[21, 10], [21, 10]]),  // a beats b
          match('m2', 'a', 'c', [[21, 15], [21, 15]]),  // a beats c
          match('m3', 'b', 'c', [[21, 19], [21, 19]]),  // b beats c
        ],
      }],
    };
    const standings = computeStandings(group, participants);
    expect(standings.map(s => s.participantId)).toEqual(['a', 'b', 'c']);
    expect(standings[0]).toMatchObject({ rank: 1, won: 2, lost: 0 });
    expect(standings[2]).toMatchObject({ rank: 3, won: 0, lost: 2 });
  });

  it('breaks ties on set difference', () => {
    const participants = ['a', 'b', 'c'].map(id => part(id, id.toUpperCase()));
    const group: Group = {
      id: 'g', name: 'G', category: '', classes: [], mode: 'round_robin',
      members: ['a', 'b', 'c'],
      rounds: [{
        roundNo: 1,
        matches: [
          // a beats b 2-1 (3 sets); a beats c 2-0; b beats c 2-1
          match('m1', 'a', 'b', [[21, 10], [10, 21], [21, 10]]),
          match('m2', 'a', 'c', [[21, 10], [21, 10]]),
          match('m3', 'b', 'c', [[21, 10], [10, 21], [21, 10]]),
        ],
      }],
    };
    const standings = computeStandings(group, participants);
    expect(standings[0].participantId).toBe('a');
    // a: setsWon 4, setsLost 1, sd = +3
    expect(standings[0].setsWon - standings[0].setsLost).toBe(3);
  });

  it('uses head-to-head as final tiebreaker when sets and points are equal', () => {
    const participants = ['a', 'b'].map(id => part(id, id.toUpperCase()));
    const group: Group = {
      id: 'g', name: 'G', category: '', classes: [], mode: 'round_robin',
      members: ['a', 'b'],
      rounds: [{
        roundNo: 1,
        // identical-shape scores; a wins both sets vs b
        matches: [match('m1', 'a', 'b', [[21, 10], [21, 10]])],
      }],
    };
    const standings = computeStandings(group, participants);
    expect(standings[0].participantId).toBe('a');
  });

  it('ignores pending matches', () => {
    const participants = [part('a', 'A'), part('b', 'B')];
    const group: Group = {
      id: 'g', name: 'G', category: '', classes: [], mode: 'round_robin',
      members: ['a', 'b'],
      rounds: [{
        roundNo: 1,
        matches: [{
          id: 'm1', p1: 'a', p2: 'b', court: '',
          score: [], status: 'pending', walkover: null,
          startedAt: null, finishedAt: null,
        }],
      }],
    };
    const standings = computeStandings(group, participants);
    expect(standings.every(s => s.played === 0)).toBe(true);
  });

  it('credits walkover wins without set/point delta', () => {
    const participants = [part('a', 'A'), part('b', 'B')];
    const group: Group = {
      id: 'g', name: 'G', category: '', classes: [], mode: 'round_robin',
      members: ['a', 'b'],
      rounds: [{
        roundNo: 1,
        matches: [walkoverMatch('m1', 'a', 'b', 'p1')],
      }],
    };
    const standings = computeStandings(group, participants);
    const a = standings.find(s => s.participantId === 'a')!;
    const b = standings.find(s => s.participantId === 'b')!;
    expect(a).toMatchObject({ won: 1, lost: 0, played: 1, setsWon: 0, setsLost: 0, pointsWon: 0, pointsLost: 0 });
    expect(b).toMatchObject({ won: 0, lost: 1, played: 1, setsWon: 0, setsLost: 0 });
  });

  it('sinks withdrawn players to the bottom regardless of wins', () => {
    // 'a' has zero wins; 'b' is withdrawn but has one win. 'a' should still
    // rank ahead because withdrawn rows sink.
    const participants: Participant[] = [
      { ...part('a', 'A') },
      { ...part('b', 'B'), withdrawn: true },
      part('c', 'C'),
    ];
    const group: Group = {
      id: 'g', name: 'G', category: '', classes: [], mode: 'round_robin',
      members: ['a', 'b', 'c'],
      rounds: [{
        roundNo: 1,
        matches: [
          match('m1', 'b', 'c', [[21, 10], [21, 10]]),  // b beats c
        ],
      }],
    };
    const standings = computeStandings(group, participants);
    expect(standings.map(s => s.participantId)).toEqual(['a', 'c', 'b']);
    expect(standings.find(s => s.participantId === 'b')!.withdrawn).toBe(true);
  });
});
