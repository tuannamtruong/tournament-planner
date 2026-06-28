// Shared match-result simulation helpers, used by both simulate-tournament.ts
// (which builds and plays a whole tournament) and randomize-results.ts (which
// fills results into existing groups & brackets).

// Deterministic PRNG (mulberry32) so re-runs with the same seed are identical.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One badminton set: loser scores 12–19, winner reaches 21 (or 22–24 in tight
// sets where the loser was at 20+).
export function simulateSetScore(p1Wins: boolean, rand: () => number): [number, number] {
  const loserPts = 12 + Math.floor(rand() * 8);
  let winnerPts = 21;
  if (loserPts >= 20) winnerPts = loserPts + 2;
  return p1Wins ? [winnerPts, loserPts] : [loserPts, winnerPts];
}

// Best-of-3 match: 50/50 winner, ~55% straight-sets, else a 3-set decider.
export function simulateMatch(rand: () => number): { score: [number, number][]; p1Won: boolean } {
  const p1Won = rand() < 0.5;
  const straight = rand() < 0.55;
  const sets: [number, number][] = [];
  if (straight) {
    sets.push(simulateSetScore(p1Won, rand));
    sets.push(simulateSetScore(p1Won, rand));
  } else {
    // Split first two, decider goes to the winner.
    sets.push(simulateSetScore(!p1Won, rand));
    sets.push(simulateSetScore(p1Won, rand));
    sets.push(simulateSetScore(p1Won, rand));
  }
  return { score: sets, p1Won };
}
