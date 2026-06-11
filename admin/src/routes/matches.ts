import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { mutate } from '../storage.ts';
import { Score, MatchStatus } from '../schema.ts';

const ScorePatch = z.object({
  score: Score.optional(),
  status: MatchStatus.optional(),
  court: z.string().optional(),
});

const NewManualMatch = z.object({
  p1: z.string(),
  p2: z.string(),
  court: z.string().default(''),
  roundNo: z.number().int().positive().default(1),
});

export async function matchRoutes(app: FastifyInstance) {
  app.patch('/api/groups/:gid/matches/:mid', async (req) => {
    const { gid, mid } = req.params as { gid: string; mid: string };
    const patch = ScorePatch.parse(req.body);
    return mutate(
      { action: 'patch_match', target: mid, payload: patch },
      (s) => {
        const g = s.groups.find(g => g.id === gid);
        if (!g) throw new Error(`group ${gid} not found`);
        for (const r of g.rounds) {
          const m = r.matches.find(m => m.id === mid);
          if (!m) continue;
          if (patch.score !== undefined) m.score = patch.score;
          if (patch.court !== undefined) m.court = patch.court;
          if (patch.status !== undefined) {
            m.status = patch.status;
            const now = new Date().toISOString();
            if (patch.status === 'live' && !m.startedAt) m.startedAt = now;
            if (patch.status === 'done' && !m.finishedAt) m.finishedAt = now;
          }
          return s;
        }
        throw new Error(`match ${mid} not found`);
      },
    );
  });

  app.post('/api/groups/:gid/matches', async (req) => {
    const { gid } = req.params as { gid: string };
    const body = NewManualMatch.parse(req.body);
    return mutate(
      { action: 'add_manual_match', target: gid, payload: body },
      (s) => {
        const g = s.groups.find(g => g.id === gid);
        if (!g) throw new Error(`group ${gid} not found`);
        let round = g.rounds.find(r => r.roundNo === body.roundNo);
        if (!round) {
          round = { roundNo: body.roundNo, matches: [] };
          g.rounds.push(round);
          g.rounds.sort((a, b) => a.roundNo - b.roundNo);
        }
        round.matches.push({
          id: nanoid(10),
          p1: body.p1, p2: body.p2,
          court: body.court,
          score: [], status: 'pending',
          startedAt: null, finishedAt: null,
        });
        return s;
      },
    );
  });
}
