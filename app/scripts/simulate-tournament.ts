// Simulate a full tournament: partition participants by (category, class) into
// round-robin groups of 4 (leftovers randomly added), generate all matches with
// realistic scores, then build & play a knockout for every (category, class)
// combination so each one crowns a champion.
//
// Run with:  npx tsx scripts/simulate-tournament.ts

import { mutate } from '../admin/src/storage.ts';
import { nanoid } from 'nanoid';
import { roundRobin } from '../admin/src/pairing/round_robin.ts';
import { computeStandings } from '../admin/src/standings.ts';
import { rng, simulateMatch } from './lib/sim.ts';
import type { Group, Match, Round, Bracket, BracketRound, BracketSlot, Participant } from '../admin/src/schema.ts';

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Partition members into groups of 4. Any leftover (1–3) is spread evenly so
// the first `leftover` groups end up with 5 — e.g. 14 → 5/5/4, not 6/4/4 or
// 4/4/4 + 2 unassigned. Pools < 4 form a single short group.
function partitionGroups(members: string[], rand: () => number): string[][] {
  const shuffled = shuffle(members, rand);
  if (shuffled.length < 4) return shuffled.length === 0 ? [] : [shuffled];
  const numGroups = Math.floor(shuffled.length / 4);
  const groups: string[][] = Array.from({ length: numGroups }, () => []);
  // Round-robin every shuffled member into a bucket. Order is randomized, so
  // dealing in order distributes evenly without re-introducing seed bias.
  for (let i = 0; i < shuffled.length; i++) {
    groups[i % numGroups].push(shuffled[i]);
  }
  return groups;
}

function materializeRound(roundNo: number, pairs: { p1: string; p2: string | null }[]): Round {
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

function buildGroupRounds(memberIds: string[], rand: () => number, baseTime: number): Round[] {
  const schedule = roundRobin(memberIds);
  const rounds: Round[] = [];
  let t = baseTime;
  for (const r of schedule) {
    const round = materializeRound(r.roundNo, r.pairs);
    for (const m of round.matches) {
      if (m.p2 === '__bye__') {
        // Mark byes as done with no score.
        m.status = 'done';
        m.startedAt = new Date(t).toISOString();
        m.finishedAt = new Date(t + 60_000).toISOString();
        t += 60_000;
        continue;
      }
      const sim = simulateMatch(rand);
      m.score = sim.score;
      m.status = 'done';
      m.startedAt = new Date(t).toISOString();
      m.finishedAt = new Date(t + 25 * 60_000).toISOString();
      m.court = 'C' + (1 + Math.floor(rand() * 8));
      t += 30 * 60_000;
    }
    rounds.push(round);
  }
  return rounds;
}

// Standard single-elim seed ordering (slot p1 / p2 alternating).
function seedOrder(size: number): number[] {
  let arr = [1, 2];
  while (arr.length < size) {
    const next: number[] = [];
    const round = arr.length * 2;
    for (const s of arr) next.push(s, round + 1 - s);
    arr = next;
  }
  return arr;
}

function emptyBracket(meta: { id: string; name: string; category: string; classes: string[] }, size: number): Bracket {
  const rounds: BracketRound[] = [];
  let slots = size / 2;
  let roundNo = 1;
  while (slots >= 1) {
    rounds.push({
      roundNo,
      slots: Array.from({ length: slots }, (_, i): BracketSlot => ({
        slot: i + 1,
        p1: null,
        p2: null,
        matchId: nanoid(10),
        court: '',
        score: [],
        status: 'pending',
        winner: null,
        startedAt: null,
        finishedAt: null,
      })),
    });
    if (slots === 1) break;
    slots /= 2;
    roundNo++;
  }
  return { ...meta, size, rounds };
}

function simulateBracket(kb: Bracket, rand: () => number, baseTime: number): void {
  let t = baseTime;
  for (let r = 0; r < kb.rounds.length; r++) {
    const round = kb.rounds[r];
    for (const slot of round.slots) {
      // Walkover handling: if exactly one side is filled, that player advances.
      if (slot.p1 && !slot.p2) {
        slot.winner = slot.p1;
        slot.status = 'done';
        slot.startedAt = new Date(t).toISOString();
        slot.finishedAt = new Date(t + 60_000).toISOString();
        t += 60_000;
      } else if (slot.p2 && !slot.p1) {
        slot.winner = slot.p2;
        slot.status = 'done';
        slot.startedAt = new Date(t).toISOString();
        slot.finishedAt = new Date(t + 60_000).toISOString();
        t += 60_000;
      } else if (slot.p1 && slot.p2) {
        const sim = simulateMatch(rand);
        slot.score = sim.score;
        slot.winner = sim.p1Won ? slot.p1 : slot.p2;
        slot.status = 'done';
        slot.startedAt = new Date(t).toISOString();
        slot.finishedAt = new Date(t + 25 * 60_000).toISOString();
        slot.court = 'C' + (1 + Math.floor(rand() * 8));
        t += 30 * 60_000;
      } else {
        continue;
      }
      const next = kb.rounds[r + 1];
      if (next) {
        const nextSlotIdx = Math.ceil(slot.slot / 2);
        const ns = next.slots.find(s => s.slot === nextSlotIdx);
        if (ns) {
          if (slot.slot % 2 === 1) ns.p1 = slot.winner;
          else ns.p2 = slot.winner;
        }
      }
    }
  }
}

const SEED = 20260612;
const rand = rng(SEED);

const next = await mutate(
  { action: 'simulate_full_tournament', payload: { seed: SEED } },
  (s) => {
    // Wipe any existing groups & brackets to make this rerunnable.
    s.groups = [];
    s.knockouts = [];

    // Bucket participants by (category, class). Skip withdrawn and any with
    // missing category/class so we don't form mixed-discipline groups.
    const pools = new Map<string, Participant[]>();
    for (const p of s.participants) {
      if (p.withdrawn) continue;
      if (!p.category || !p.class) continue;
      const key = `${p.category}-${p.class}`;
      if (!pools.has(key)) pools.set(key, []);
      pools.get(key)!.push(p);
    }

    const baseTime = Date.parse('2026-06-13T08:00:00Z');
    const sortedKeys = [...pools.keys()].sort();

    for (const key of sortedKeys) {
      const pool = pools.get(key)!;
      const [category, cls] = key.split('-');
      const partitions = partitionGroups(pool.map(p => p.id), rand);
      partitions.forEach((memberIds, idx) => {
        const groupName = `${category}-${cls} Gruppe ${String.fromCharCode(65 + idx)}`;
        const group: Group = {
          id: nanoid(6),
          name: groupName,
          mode: 'round_robin',
          category,
          classes: [cls],
          members: memberIds,
          rounds: buildGroupRounds(memberIds, rand, baseTime),
        };
        s.groups.push(group);
      });
    }

    // One knockout per (category, class). Seed from group winners + best
    // runners-up; pad up to a power of two with BYEs so every draw plays out
    // to a single champion.
    const bracketBaseTime = Date.parse('2026-06-14T08:00:00Z');
    for (const key of sortedKeys) {
      const [category, cls] = key.split('-');
      const groupsForKey = s.groups.filter(
        g => g.category === category && g.classes.includes(cls),
      );
      if (groupsForKey.length === 0) continue;

      const winners: string[] = [];
      const runnersUp: string[] = [];
      for (const g of groupsForKey) {
        const standings = computeStandings(g, s.participants);
        if (standings[0]) winners.push(standings[0].participantId);
        if (standings[1]) runnersUp.push(standings[1].participantId);
      }
      const qualified = winners.length + runnersUp.length;
      if (qualified < 2) continue; // can't form a 2-slot draw

      let size = 2;
      while (size < winners.length) size *= 2;
      // Try to grow to fit the runners-up too, capped at the available field.
      while (size < qualified && size < 32) size *= 2;
      size = Math.max(size, 2);

      const seeds: string[] = [...winners];
      for (const r of runnersUp) {
        if (seeds.length >= size) break;
        seeds.push(r);
      }
      while (seeds.length < size) seeds.push(''); // BYE

      const kb = emptyBracket(
        {
          id: 'kb-' + nanoid(8),
          name: `${category}-${cls} KO`,
          category,
          classes: [cls],
        },
        size,
      );
      const order = seedOrder(size);
      const firstRound = kb.rounds[0];
      for (let i = 0; i < order.length; i++) {
        const seedNo = order[i];
        const id = seeds[seedNo - 1] || null;
        const slotIdx = Math.floor(i / 2);
        const slot = firstRound.slots[slotIdx];
        if (i % 2 === 0) slot.p1 = id;
        else slot.p2 = id;
      }
      simulateBracket(kb, rand, bracketBaseTime);
      s.knockouts.push(kb);
    }

    return s;
  },
);

// Report.
console.log(`tournament: ${next.tournament.name}`);
console.log(`participants: ${next.participants.length}`);
console.log(`groups: ${next.groups.length}`);
const totalMatches = next.groups.reduce(
  (n, g) => n + g.rounds.reduce((m, r) => m + r.matches.length, 0),
  0,
);
const donePct = (() => {
  let done = 0, all = 0;
  for (const g of next.groups) {
    for (const r of g.rounds) {
      for (const m of r.matches) {
        all++;
        if (m.status === 'done') done++;
      }
    }
  }
  return all === 0 ? 0 : Math.round((done / all) * 100);
})();
console.log(`group matches: ${totalMatches} (${donePct}% done)`);
console.log(`knockouts: ${next.knockouts.length}`);
for (const kb of next.knockouts) {
  const final = kb.rounds.at(-1);
  const champion = final?.slots[0]?.winner;
  const champName = champion
    ? (next.participants.find(p => p.id === champion)?.name ?? champion)
    : '(none)';
  console.log(`  ${kb.name} (size ${kb.size}, ${kb.rounds.length} rounds): champion = ${champName}`);
}
const groupsByCat = new Map<string, number>();
for (const g of next.groups) {
  const k = `${g.category}-${g.classes.join('') || '·'}`;
  groupsByCat.set(k, (groupsByCat.get(k) ?? 0) + 1);
}
for (const [k, n] of [...groupsByCat].sort()) console.log(`  ${k}: ${n} group(s)`);
