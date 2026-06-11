import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { mutate } from '../storage.ts';
import { Score, type Knockout, type BracketRound, type BracketSlot } from '../schema.ts';

const CreateBracket = z.object({
  size: z.number().int().positive(),       // 4, 8, 16, 32
  seeds: z.array(z.string()).default([]),  // ordered list of participant IDs; gaps padded with nulls
});

const PatchSlot = z.object({
  p1: z.string().nullable().optional(),
  p2: z.string().nullable().optional(),
  score: Score.optional(),
  winner: z.string().nullable().optional(),
});

function emptyBracket(size: number): Knockout {
  const rounds: BracketRound[] = [];
  let slots = size / 2;
  let roundNo = 1;
  while (slots >= 1) {
    const r: BracketRound = {
      roundNo,
      slots: Array.from({ length: slots }, (_, i): BracketSlot => ({
        slot: i + 1,
        p1: null, p2: null,
        matchId: nanoid(10),
        score: [], winner: null,
      })),
    };
    rounds.push(r);
    if (slots === 1) break;
    slots /= 2;
    roundNo++;
  }
  return { size, rounds };
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
  app.post('/api/knockout', async (req) => {
    const body = CreateBracket.parse(req.body);
    return mutate(
      { action: 'create_bracket', payload: { size: body.size } },
      (s) => {
        const kb = emptyBracket(body.size);
        const order = seedOrder(body.size);
        const firstRound = kb.rounds[0];
        for (let i = 0; i < order.length; i++) {
          const seedNo = order[i];
          const id = body.seeds[seedNo - 1] ?? null;
          const slotIdx = Math.floor(i / 2);
          const slot = firstRound.slots[slotIdx];
          if (i % 2 === 0) slot.p1 = id; else slot.p2 = id;
        }
        s.knockout = kb;
        return s;
      },
    );
  });

  app.patch('/api/knockout/round/:r/slot/:s', async (req) => {
    const { r, s: slotS } = req.params as { r: string; s: string };
    const roundNo = Number(r);
    const slotNo = Number(slotS);
    const patch = PatchSlot.parse(req.body);
    return mutate(
      { action: 'patch_slot', target: `r${roundNo}s${slotNo}`, payload: patch },
      (state) => {
        if (!state.knockout) throw new Error('no bracket exists');
        const round = state.knockout.rounds.find(r => r.roundNo === roundNo);
        if (!round) throw new Error(`bracket round ${roundNo} not found`);
        const slot = round.slots.find(s => s.slot === slotNo);
        if (!slot) throw new Error(`slot ${slotNo} not found`);
        if (patch.p1 !== undefined) slot.p1 = patch.p1;
        if (patch.p2 !== undefined) slot.p2 = patch.p2;
        if (patch.score !== undefined) slot.score = patch.score;
        if (patch.winner !== undefined) {
          slot.winner = patch.winner;
          // Propagate winner into next round's slot
          const nextRound = state.knockout.rounds.find(r => r.roundNo === roundNo + 1);
          if (nextRound) {
            const nextSlotIdx = Math.ceil(slotNo / 2);
            const nextSlot = nextRound.slots.find(s => s.slot === nextSlotIdx);
            if (nextSlot) {
              if (slotNo % 2 === 1) nextSlot.p1 = patch.winner;
              else nextSlot.p2 = patch.winner;
            }
          }
        }
        return state;
      },
    );
  });

  app.delete('/api/knockout', async () => {
    return mutate(
      { action: 'delete_bracket' },
      (s) => { s.knockout = null; return s; },
    );
  });
}
