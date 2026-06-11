import type { Pairing } from './round_robin.ts';

export type SwissPlayer = {
  id: string;
  points: number;        // 1 per match win, 0 per loss; bye usually scored as a win
  opponents: Set<string>;
  hadBye: boolean;
};

export type SwissResult = { pairs: Pairing[]; bye: string | null };

/**
 * Swiss pairing for one round. Ranks by points desc (stable), then pairs greedily
 * with backtracking, never repeating opponents. Lowest-ranked unbyed player gets
 * the bye on odd counts.
 *
 * Throws if no rematch-free pairing exists (rare; only when most players have
 * already played each other).
 */
export function swissPairings(players: SwissPlayer[]): SwissResult {
  const ranked = [...players].sort((a, b) => b.points - a.points);

  let bye: string | null = null;
  let active = ranked;
  if (ranked.length % 2 === 1) {
    let byeIdx = -1;
    for (let i = ranked.length - 1; i >= 0; i--) {
      if (!ranked[i].hadBye) { byeIdx = i; break; }
    }
    if (byeIdx === -1) byeIdx = ranked.length - 1;
    bye = ranked[byeIdx].id;
    active = ranked.filter((_, i) => i !== byeIdx);
  }

  const pairs: Pairing[] = [];
  const used = new Set<string>();

  const solve = (i: number): boolean => {
    while (i < active.length && used.has(active[i].id)) i++;
    if (i >= active.length) return true;
    const a = active[i];
    for (let j = i + 1; j < active.length; j++) {
      const b = active[j];
      if (used.has(b.id)) continue;
      if (a.opponents.has(b.id)) continue;
      used.add(a.id); used.add(b.id);
      pairs.push({ p1: a.id, p2: b.id });
      if (solve(i + 1)) return true;
      pairs.pop();
      used.delete(a.id); used.delete(b.id);
    }
    return false;
  };

  if (!solve(0)) {
    throw new Error('Swiss: no rematch-free pairing possible. Run fewer rounds or pair manually.');
  }
  return { pairs, bye };
}
