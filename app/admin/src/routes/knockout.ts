import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { mutate } from '../storage.ts';
import { Score, MatchStatus, Walkover, type Bracket, type BracketRound, type BracketSlot } from '../schema.ts';

const CreateBracket = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  classes: z.array(z.string()).min(1),
  size: z.number().int().min(2),         // requested player count; rounded up to next power of 2
  seeds: z.array(z.string()).default([]), // ordered participant IDs; gaps become BYE
  pointSystemId: z.string().nullable().default(null),
});

const PatchRound = z.object({
  name: z.string().min(1).max(60),
});

const PatchSlot = z.object({
  p1: z.string().nullable().optional(),
  p2: z.string().nullable().optional(),
  court: z.string().optional(),
  score: Score.optional(),
  status: MatchStatus.optional(),
  winner: z.string().nullable().optional(),
  walkover: Walkover.optional(),
});

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return Math.max(2, p);
}

// Default label for a round whose winners' slot count (i.e. number of matches
// in that round) is `slots`. 1 → Final, 2 → Semifinal, 4 → Quarter Final,
// anything bigger → "Round of {2*slots}". Operator may override per round.
export function defaultRoundName(slots: number): string {
  if (slots === 1) return 'Final';
  if (slots === 2) return 'Semifinal';
  if (slots === 4) return 'Quarter Final';
  return `Round of ${slots * 2}`;
}

function emptyBracket(meta: { id: string; name: string; category: string; classes: string[]; pointSystemId: string | null }, slotCount: number): Bracket {
  const rounds: BracketRound[] = [];
  let slots = slotCount / 2;
  let roundNo = 1;
  while (slots >= 1) {
    const r: BracketRound = {
      roundNo,
      name: defaultRoundName(slots),
      slots: Array.from({ length: slots }, (_, i): BracketSlot => ({
        slot: i + 1,
        p1: null, p2: null,
        matchId: nanoid(10),
        court: '',
        score: [],
        status: 'pending',
        walkover: null,
        winner: null,
        startedAt: null,
        finishedAt: null,
      })),
    };
    rounds.push(r);
    if (slots === 1) break;
    slots /= 2;
    roundNo++;
  }
  return { ...meta, size: slotCount, rounds };
}

/**
 * Standard single-elim seeding for a bracket of size N. Returns the order in
 * which seeds populate slots [(slot1.p1, slot1.p2), (slot2.p1, slot2.p2), ...].
 * For size 8: [1, 8, 4, 5, 3, 6, 2, 7].
 */
function seedOrder(size: number): number[] {
  let arr = [1, 2];
  while (arr.length < size) {
    const next: number[] = [];
    const round = arr.length * 2;
    for (const s of arr) { next.push(s, round + 1 - s); }
    arr = next;
  }
  return arr;
}

export async function knockoutRoutes(app: FastifyInstance) {
  app.post('/api/knockouts', async (req) => {
    const body = CreateBracket.parse(req.body);
    const slotCount = nextPow2(body.size);
    const id = 'kb-' + nanoid(8);
    return mutate(
      { action: 'create_bracket', target: id, payload: { name: body.name, category: body.category, classes: body.classes, size: body.size, slotCount } },
      (s) => {
        const kb = emptyBracket({ id, name: body.name, category: body.category, classes: body.classes, pointSystemId: body.pointSystemId }, slotCount);
        const order = seedOrder(slotCount);
        const firstRound = kb.rounds[0];
        for (let i = 0; i < order.length; i++) {
          const seedNo = order[i];
          const id = body.seeds[seedNo - 1] ?? null;
          const slotIdx = Math.floor(i / 2);
          const slot = firstRound.slots[slotIdx];
          if (i % 2 === 0) slot.p1 = id; else slot.p2 = id;
        }
        // Auto-advance any slot where the opponent is a BYE: the lone player
        // wins by walkover, the slot is marked done (so it never shows up
        // as a playable match), and the winner propagates to round 2.
        for (const slot of firstRound.slots) {
          const lone = slot.p1 && !slot.p2 ? slot.p1
                      : !slot.p1 && slot.p2 ? slot.p2
                      : null;
          if (lone) {
            slot.winner = lone;
            slot.status = 'done';
            propagate(kb, 1, slot.slot, lone);
          }
        }
        s.knockouts.push(kb);
        return s;
      },
    );
  });

  app.patch('/api/knockouts/:kid/round/:r', async (req) => {
    const { kid, r } = req.params as { kid: string; r: string };
    const roundNo = Number(r);
    const patch = PatchRound.parse(req.body);
    return mutate(
      { action: 'rename_round', target: `${kid}/r${roundNo}`, payload: patch },
      (state) => {
        const kb = state.knockouts.find(k => k.id === kid);
        if (!kb) throw new Error(`bracket ${kid} not found`);
        const round = kb.rounds.find(r => r.roundNo === roundNo);
        if (!round) throw new Error(`bracket round ${roundNo} not found`);
        round.name = patch.name.trim();
        return state;
      },
    );
  });

  app.patch('/api/knockouts/:kid/round/:r/slot/:s', async (req) => {
    const { kid, r, s: slotS } = req.params as { kid: string; r: string; s: string };
    const roundNo = Number(r);
    const slotNo = Number(slotS);
    const patch = PatchSlot.parse(req.body);
    return mutate(
      { action: 'patch_slot', target: `${kid}/r${roundNo}s${slotNo}`, payload: patch },
      (state) => {
        const kb = state.knockouts.find(k => k.id === kid);
        if (!kb) throw new Error(`bracket ${kid} not found`);
        const round = kb.rounds.find(r => r.roundNo === roundNo);
        if (!round) throw new Error(`bracket round ${roundNo} not found`);
        const slot = round.slots.find(s => s.slot === slotNo);
        if (!slot) throw new Error(`slot ${slotNo} not found`);
        if (patch.p1 !== undefined) slot.p1 = patch.p1;
        if (patch.p2 !== undefined) slot.p2 = patch.p2;
        if (patch.court !== undefined) slot.court = patch.court;
        if (patch.score !== undefined) slot.score = patch.score;
        const now = new Date().toISOString();
        if (patch.walkover !== undefined) {
          slot.walkover = patch.walkover;
          if (patch.walkover === null) {
            slot.winner = null;
          } else {
            const winnerId = patch.walkover === 'p1' ? slot.p1 : slot.p2;
            if (!winnerId) throw new Error(`cannot walkover side ${patch.walkover} — that side is empty`);
            slot.score = [];
            slot.status = 'done';
            slot.winner = winnerId;
            if (!slot.finishedAt) slot.finishedAt = now;
            propagate(kb, roundNo, slotNo, winnerId);
          }
        }
        if (patch.status !== undefined) {
          slot.status = patch.status;
          if (patch.status === 'live' && !slot.startedAt) slot.startedAt = now;
          if (patch.status === 'done' && !slot.finishedAt) slot.finishedAt = now;
        }
        if (patch.winner !== undefined) {
          slot.winner = patch.winner;
          if (patch.winner) {
            slot.status = 'done';
            if (!slot.finishedAt) slot.finishedAt = now;
            propagate(kb, roundNo, slotNo, patch.winner);
          }
        }
        return state;
      },
    );
  });

  app.delete('/api/knockouts/:kid', async (req) => {
    const { kid } = req.params as { kid: string };
    return mutate(
      { action: 'delete_bracket', target: kid },
      (s) => {
        const idx = s.knockouts.findIndex(k => k.id === kid);
        if (idx === -1) throw new Error(`bracket ${kid} not found`);
        s.knockouts.splice(idx, 1);
        return s;
      },
    );
  });
}

export function propagate(kb: Bracket, roundNo: number, slotNo: number, winnerId: string): void {
  const nextRound = kb.rounds.find(r => r.roundNo === roundNo + 1);
  if (!nextRound) return;
  const nextSlotIdx = Math.ceil(slotNo / 2);
  const nextSlot = nextRound.slots.find(s => s.slot === nextSlotIdx);
  if (!nextSlot) return;
  if (slotNo % 2 === 1) nextSlot.p1 = winnerId;
  else nextSlot.p2 = winnerId;
}
