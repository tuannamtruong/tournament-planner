// Re-randomize results for the groups & brackets that ALREADY exist in
// tournament.json. Unlike simulate-tournament.ts, this is non-destructive to
// structure: it keeps every group, its members and pairings, and each bracket's
// seeding untouched — it only (re)generates the *results*.
//
// Every match is overwritten on each run. Withdrawn participants forfeit by
// walkover; byes are marked done with no score. Knockout rounds are re-played
// from round 1 so winners propagate correctly.
//
// Run with:  npx tsx scripts/randomize-results.ts   (SEED=n for a variant)

import { mutate } from '../admin/src/storage.ts';
import { propagate } from '../admin/src/routes/knockout.ts';
import { rng, simulateMatch } from './lib/sim.ts';
import type { Tournament as TournamentT } from '../admin/src/schema.ts';

const SEED = Number(process.env.SEED ?? 20260628);
const rand = rng(SEED);

const BYE = '__bye__';
const baseTime = Date.parse('2026-06-13T08:00:00Z');
let clock = baseTime;
const randomCourt = () => 'C' + (1 + Math.floor(rand() * 8));

const next = await mutate(
  { action: 'randomize_all_results', payload: { seed: SEED } },
  (s) => {
    const withdrawn = new Set(s.participants.filter(p => p.withdrawn).map(p => p.id));

    // --- Group matches -----------------------------------------------------
    for (const g of s.groups) {
      for (const r of g.rounds) {
        for (const m of r.matches) {
          // Reset, then decide an outcome.
          m.score = [];
          m.walkover = null;
          m.court = '';
          m.startedAt = null;
          m.finishedAt = null;

          if (m.p1 === BYE || m.p2 === BYE) {
            // Bye: counts as done, no score.
            m.status = 'done';
            m.startedAt = new Date(clock).toISOString();
            m.finishedAt = new Date(clock + 60_000).toISOString();
            clock += 60_000;
            continue;
          }

          const p1Out = withdrawn.has(m.p1);
          const p2Out = withdrawn.has(m.p2);
          if (p1Out || p2Out) {
            // Forfeit: the side still standing wins by walkover (if both are
            // withdrawn, leave it a scoreless done match with no winner).
            m.walkover = p1Out && p2Out ? null : p1Out ? 'p2' : 'p1';
            m.status = 'done';
            m.startedAt = new Date(clock).toISOString();
            m.finishedAt = new Date(clock + 60_000).toISOString();
            clock += 60_000;
            continue;
          }

          const sim = simulateMatch(rand);
          m.score = sim.score;
          m.status = 'done';
          m.court = randomCourt();
          m.startedAt = new Date(clock).toISOString();
          m.finishedAt = new Date(clock + 25 * 60_000).toISOString();
          clock += 30 * 60_000;
        }
      }
    }

    // --- Knockout brackets -------------------------------------------------
    // Re-play each bracket from round 1: round-1 seeding (p1/p2) is preserved,
    // later rounds are recomputed via propagate() as winners are decided.
    for (const kb of s.knockouts) {
      for (const round of kb.rounds) {
        for (const slot of round.slots) {
          slot.score = [];
          slot.winner = null;
          slot.walkover = null;
          slot.status = 'pending';
          slot.court = '';
          slot.startedAt = null;
          slot.finishedAt = null;
          if (round.roundNo > 1) { slot.p1 = null; slot.p2 = null; }
        }
      }

      for (const round of kb.rounds) {
        for (const slot of round.slots) {
          const p1Out = slot.p1 ? withdrawn.has(slot.p1) : false;
          const p2Out = slot.p2 ? withdrawn.has(slot.p2) : false;

          let winnerId: string | null = null;
          if (slot.p1 && slot.p2 && !p1Out && !p2Out) {
            const sim = simulateMatch(rand);
            slot.score = sim.score;
            winnerId = sim.p1Won ? slot.p1 : slot.p2;
            slot.status = 'done';
            slot.court = randomCourt();
            slot.startedAt = new Date(clock).toISOString();
            slot.finishedAt = new Date(clock + 25 * 60_000).toISOString();
            clock += 30 * 60_000;
          } else if (slot.p1 || slot.p2) {
            // Lone player (bye) or the only non-withdrawn side: walkover advance.
            const lone = !slot.p2 || p2Out ? slot.p1 : slot.p2;
            const loneOut = lone === slot.p1 ? p1Out : p2Out;
            if (lone && !loneOut) {
              winnerId = lone;
              if (slot.p1 && slot.p2) slot.walkover = lone === slot.p1 ? 'p1' : 'p2';
              slot.status = 'done';
              slot.startedAt = new Date(clock).toISOString();
              slot.finishedAt = new Date(clock + 60_000).toISOString();
              clock += 60_000;
            }
          }

          if (winnerId) {
            slot.winner = winnerId;
            propagate(kb, round.roundNo, slot.slot, winnerId);
          }
        }
      }
    }

    return s;
  },
);

// --- Report --------------------------------------------------------------
report(next);

function report(t: TournamentT): void {
  if (t.groups.length === 0 && t.knockouts.length === 0) {
    console.log('nothing to randomize — no groups or brackets exist yet.');
    console.log('create groups/brackets in the admin first, or run `npx tsx scripts/simulate-tournament.ts`.');
    return;
  }

  console.log(`tournament: ${t.tournament.name}  (seed ${SEED})`);
  console.log(`groups: ${t.groups.length}`);
  let done = 0, all = 0;
  for (const g of t.groups)
    for (const r of g.rounds)
      for (const m of r.matches) { all++; if (m.status === 'done') done++; }
  const pct = all === 0 ? 0 : Math.round((done / all) * 100);
  console.log(`group matches: ${all} (${pct}% done)`);

  console.log(`knockouts: ${t.knockouts.length}`);
  for (const kb of t.knockouts) {
    const champion = kb.rounds.at(-1)?.slots[0]?.winner;
    const champName = champion
      ? (t.participants.find(p => p.id === champion)?.players.join(' & ') ?? champion)
      : '(unresolved)';
    console.log(`  ${kb.name} (size ${kb.size}): champion = ${champName}`);
  }
}
