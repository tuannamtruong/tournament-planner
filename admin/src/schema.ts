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

// Bracket slots are scored from the Matches tab just like group matches, so
// they carry the same status/court/timestamp fields. `status` is derived in
// the PATCH route: setting a winner forces 'done'; an explicit { status: 'live' }
// marks the slot live without picking a winner yet.
export const BracketSlot = z.object({
  slot: z.number().int().positive(),
  p1: z.string().nullable(),
  p2: z.string().nullable(),
  matchId: z.string().nullable(),
  court: z.string().default(''),
  score: Score.default([]),
  status: MatchStatus.default('pending'),
  winner: z.string().nullable(),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
});
export type BracketSlot = z.infer<typeof BracketSlot>;

export const BracketRound = z.object({
  roundNo: z.number().int().positive(),
  name: z.string().default(''),
  slots: z.array(BracketSlot),
});
export type BracketRound = z.infer<typeof BracketRound>;

// `size` is the actual bracket size in slots (always a power of 2). The
// operator may enter any player count N ≥ 2; the create route rounds N up
// to the next power of 2 and seats unfilled positions as BYE.
export const Bracket = z.object({
  id: z.string(),
  name: z.string().min(1),
  category: z.string().default(''),
  classes: z.array(z.string()).default([]),
  size: z.number().int().positive(),
  rounds: z.array(BracketRound),
});
export type Bracket = z.infer<typeof Bracket>;

export const AuditEntry = z.object({
  ts: z.string(),
  action: z.string(),
  target: z.string().default(''),
  payload: z.unknown().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

// Migrate legacy `knockout: Knockout | null` field on read. Existing
// tournament.json files from before the multi-bracket change still parse:
// the single bracket becomes a one-element `knockouts` array.
export const Tournament = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  if (obj.knockouts === undefined) {
    const legacy = obj.knockout;
    if (legacy && typeof legacy === 'object') {
      const k = legacy as { size: number; rounds: unknown };
      obj.knockouts = [{
        id: 'kb-legacy',
        name: 'Knockout',
        category: '',
        classes: [],
        size: k.size,
        rounds: k.rounds,
      }];
    } else {
      obj.knockouts = [];
    }
    delete obj.knockout;
  }
  return obj;
}, z.object({
  tournament: z.object({
    id: z.string(),
    name: z.string(),
    updatedAt: z.string(),
  }),
  participants: z.array(Participant).default([]),
  groups: z.array(Group).default([]),
  knockouts: z.array(Bracket).default([]),
  auditLog: z.array(AuditEntry).default([]),
}));
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
