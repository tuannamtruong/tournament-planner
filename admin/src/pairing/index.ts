import { nanoid } from 'nanoid';
import type { Group, Match, Round } from '../schema.ts';
import { roundRobin, type Pairing } from './round_robin.ts';
import { swissPairings, type SwissPlayer } from './swiss.ts';

export type { Pairing };

/**
 * Generate the next round for a group based on its mode. Returns the new Round
 * (not yet appended). The caller should push it to `group.rounds`.
 *
 * - round_robin: pre-generates the whole schedule on round 1, then returns the
 *   matching round number from the precomputed schedule.
 * - swiss: computes one round at a time from current standings + history.
 * - manual: throws — pairings are added by hand.
 */
export function generateNextRound(group: Group): Round {
  if (group.mode === 'manual') {
    throw new Error(`Group "${group.name}" is manual — add matches manually.`);
  }
  const nextRoundNo = (group.rounds.at(-1)?.roundNo ?? 0) + 1;

  if (group.mode === 'round_robin') {
    const schedule = roundRobin(group.members);
    const round = schedule.find(r => r.roundNo === nextRoundNo);
    if (!round) {
      throw new Error(`Round-robin schedule for "${group.name}" already complete.`);
    }
    return materialize(round.pairs, nextRoundNo);
  }

  // swiss
  const players: SwissPlayer[] = group.members.map(id => {
    const opponents = new Set<string>();
    let points = 0;
    let hadBye = false;
    for (const r of group.rounds) {
      for (const m of r.matches) {
        if (m.p1 === id && m.p2 === '__bye__') { hadBye = true; points += 1; continue; }
        if (m.p2 === id && m.p1 === '__bye__') { hadBye = true; points += 1; continue; }
        if (m.p1 !== id && m.p2 !== id) continue;
        const opp = m.p1 === id ? m.p2 : m.p1;
        opponents.add(opp);
        if (m.status !== 'done' || m.score.length === 0) continue;
        let p1 = 0, p2 = 0;
        for (const [a, b] of m.score) { if (a > b) p1++; else if (b > a) p2++; }
        const won = (m.p1 === id) ? p1 > p2 : p2 > p1;
        if (won) points += 1;
      }
    }
    return { id, points, opponents, hadBye };
  });

  const { pairs, bye } = swissPairings(players);
  const allPairs: Pairing[] = bye ? [...pairs, { p1: bye, p2: null }] : pairs;
  return materialize(allPairs, nextRoundNo);
}

function materialize(pairs: Pairing[], roundNo: number): Round {
  const matches: Match[] = pairs.map(p => ({
    id: nanoid(10),
    p1: p.p1,
    p2: p.p2 ?? '__bye__',
    court: '',
    score: [],
    status: 'pending',
    startedAt: null,
    finishedAt: null,
  }));
  return { roundNo, matches };
}
