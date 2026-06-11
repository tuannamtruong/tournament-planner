import type { Group, Match, Participant } from './schema.ts';

export type Standing = {
  participantId: string;
  name: string;
  played: number;
  won: number;
  lost: number;
  setsWon: number;
  setsLost: number;
  pointsWon: number;
  pointsLost: number;
  rank: number;
};

type Tally = Omit<Standing, 'rank'>;

function setScore(match: Match): { p1Sets: number; p2Sets: number; p1Pts: number; p2Pts: number } {
  let p1Sets = 0, p2Sets = 0, p1Pts = 0, p2Pts = 0;
  for (const [a, b] of match.score) {
    if (a > b) p1Sets++;
    else if (b > a) p2Sets++;
    p1Pts += a;
    p2Pts += b;
  }
  return { p1Sets, p2Sets, p1Pts, p2Pts };
}

function headToHead(aId: string, bId: string, group: Group): number {
  let aWon = 0, bWon = 0;
  for (const round of group.rounds) {
    for (const m of round.matches) {
      if (m.status !== 'done' || m.score.length === 0) continue;
      const isAB = (m.p1 === aId && m.p2 === bId) || (m.p1 === bId && m.p2 === aId);
      if (!isAB) continue;
      const { p1Sets, p2Sets } = setScore(m);
      const aIsP1 = m.p1 === aId;
      if ((p1Sets > p2Sets && aIsP1) || (p2Sets > p1Sets && !aIsP1)) aWon++;
      else if (p1Sets !== p2Sets) bWon++;
    }
  }
  return bWon - aWon;
}

export function computeStandings(group: Group, participants: Participant[]): Standing[] {
  const tally = new Map<string, Tally>();
  for (const id of group.members) {
    const p = participants.find(p => p.id === id);
    if (!p) continue;
    tally.set(id, {
      participantId: id, name: p.name,
      played: 0, won: 0, lost: 0,
      setsWon: 0, setsLost: 0,
      pointsWon: 0, pointsLost: 0,
    });
  }

  for (const round of group.rounds) {
    for (const m of round.matches) {
      if (m.status !== 'done' || m.score.length === 0) continue;
      const a = tally.get(m.p1);
      const b = tally.get(m.p2);
      if (!a || !b) continue;
      const { p1Sets, p2Sets, p1Pts, p2Pts } = setScore(m);
      a.played++; b.played++;
      a.setsWon += p1Sets; a.setsLost += p2Sets;
      b.setsWon += p2Sets; b.setsLost += p1Sets;
      a.pointsWon += p1Pts; a.pointsLost += p2Pts;
      b.pointsWon += p2Pts; b.pointsLost += p1Pts;
      if (p1Sets > p2Sets) { a.won++; b.lost++; }
      else if (p2Sets > p1Sets) { b.won++; a.lost++; }
    }
  }

  const rows = [...tally.values()];
  rows.sort((x, y) => {
    if (y.won !== x.won) return y.won - x.won;
    const xSd = x.setsWon - x.setsLost;
    const ySd = y.setsWon - y.setsLost;
    if (ySd !== xSd) return ySd - xSd;
    const xPd = x.pointsWon - x.pointsLost;
    const yPd = y.pointsWon - y.pointsLost;
    if (yPd !== xPd) return yPd - xPd;
    return headToHead(x.participantId, y.participantId, group);
  });

  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}
