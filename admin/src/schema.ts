import { z } from 'zod';

export const SetScore = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
export const Score = z.array(SetScore).max(5);

// Category: discipline (MS = men's singles, WS = women's, MD/WD = doubles, MX = mixed).
// Class: skill bracket (S = elite, A/B/C/D descending).
// Both are open strings so the operator can introduce ad-hoc values; the UI
// constrains the common ones via select inputs.
export const Participant = z.object({
  id: z.string(),
  name: z.string().min(1),
  club: z.string().default(''),
  category: z.string().default(''),
  class: z.string().default(''),
  seed: z.number().int().nonnegative().default(0),
  withdrawn: z.boolean().default(false),
});
export type Participant = z.infer<typeof Participant>;

export const MatchStatus = z.enum(['pending', 'live', 'done']);
export type MatchStatus = z.infer<typeof MatchStatus>;

export const Match = z.object({
  id: z.string(),
  p1: z.string(),
  p2: z.string(),
  court: z.string().default(''),
  score: Score.default([]),
  status: MatchStatus.default('pending'),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
});
export type Match = z.infer<typeof Match>;

export const Round = z.object({
  roundNo: z.number().int().positive(),
  matches: z.array(Match),
});
export type Round = z.infer<typeof Round>;

export const GroupMode = z.enum(['round_robin', 'swiss', 'manual']);
export type GroupMode = z.infer<typeof GroupMode>;

// A group is scoped to a single category but may span multiple classes
// (e.g. a combined A+B draw). An empty `classes` array means "any class".
export const Group = z.object({
  id: z.string(),
  name: z.string().min(1),
  mode: GroupMode,
  category: z.string().default(''),
  classes: z.array(z.string()).default([]),
  members: z.array(z.string()),
  rounds: z.array(Round).default([]),
});
export type Group = z.infer<typeof Group>;

export const BracketSlot = z.object({
  slot: z.number().int().positive(),
  p1: z.string().nullable(),
  p2: z.string().nullable(),
  matchId: z.string().nullable(),
  score: Score.default([]),
  winner: z.string().nullable(),
});
export type BracketSlot = z.infer<typeof BracketSlot>;

export const BracketRound = z.object({
  roundNo: z.number().int().positive(),
  slots: z.array(BracketSlot),
});
export type BracketRound = z.infer<typeof BracketRound>;

export const Knockout = z.object({
  size: z.number().int().positive(),
  rounds: z.array(BracketRound),
});
export type Knockout = z.infer<typeof Knockout>;

export const AuditEntry = z.object({
  ts: z.string(),
  action: z.string(),
  target: z.string().default(''),
  payload: z.unknown().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const Tournament = z.object({
  tournament: z.object({
    id: z.string(),
    name: z.string(),
    updatedAt: z.string(),
  }),
  participants: z.array(Participant).default([]),
  groups: z.array(Group).default([]),
  knockout: Knockout.nullable().default(null),
  auditLog: z.array(AuditEntry).default([]),
});
export type Tournament = z.infer<typeof Tournament>;

export function emptyTournament(): Tournament {
  return Tournament.parse({
    tournament: {
      id: 'tp-' + Date.now().toString(36),
      name: 'New Tournament',
      updatedAt: new Date().toISOString(),
    },
  });
}
