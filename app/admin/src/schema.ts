import { z } from 'zod';

export const SetScore = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]);
export const Score = z.array(SetScore).max(5);

// Category: discipline (MS = men's singles, WS = women's, MD/WD = doubles, MX = mixed).
// Class: skill bracket (S = elite, A/B/C/D descending).
// Both are open strings so the operator can introduce ad-hoc values; the UI
// constrains the common ones via select inputs.
//
// A participant row is one entry in one (category, class). `players` holds the
// player name(s): length 1 = a singles entry OR a partnerless doubles entry;
// length 2 = a paired doubles team. The display name is derived by joining with
// " & " (see nameOf). All PER-PERSON attributes (club, check-in, fee) live in
// the Registrant map keyed by normalised name, never on this row — so the same
// human across several entries shares one club/check-in/fee.
export const Participant = z.object({
  id: z.string(),
  players: z.array(z.string().min(1)).min(1).max(2),
  category: z.string().default(''),
  class: z.string().default(''),
  withdrawn: z.boolean().default(false),
});
export type Participant = z.infer<typeof Participant>;

// Display name for a participant entry: the player names joined with " & "
// (one name for singles / partnerless doubles, two for a paired team).
export function displayName(p: Participant): string {
  return p.players.join(' & ');
}

// Per-person profile, keyed by the player's normalised name (lower-cased,
// trimmed — the same key the admin UI derives from `players`). `club` is the
// player's own club; `present` = showed up at the venue; `paid`/`paidAmount` =
// their own fee. A doubles team's two members each have their own Registrant.
export const Registrant = z.object({
  club: z.string().default(''),
  present: z.boolean().default(false),
  paid: z.boolean().default(false),
  paidAmount: z.number().nonnegative().default(0),
});
export type Registrant = z.infer<typeof Registrant>;

// A named point system. A set is won at `pointsPerSet` with a 2-point lead, then
// play continues at deuce until a 2-point lead OR the cap `maxPointsPerSet` is
// reached (where a 1-point win settles it). The deciding set (3rd set of a
// best-of-3) can use a different target/cap. Drives the scoring UI's winner
// auto-fill + set validation only — the server still accepts any non-negative
// integers so the operator can override.
export const PointSystem = z.object({
  id: z.string(),
  name: z.string().min(1),
  pointsPerSet: z.number().int().positive().default(21),
  maxPointsPerSet: z.number().int().positive().default(30),
  deciderPoints: z.number().int().positive().default(21),
  deciderMaxPoints: z.number().int().positive().default(30),
});
export type PointSystem = z.infer<typeof PointSystem>;

// The library of point systems defined in the Settings tab, plus the id of the
// tournament-wide default. A group or bracket may override the default by
// referencing another system's id (see Group/Bracket.pointSystemId).
export const Scoring = z.object({
  systems: z.array(PointSystem).min(1),
  defaultId: z.string(),
});
export type Scoring = z.infer<typeof Scoring>;

// Seed for a fresh tournament: a BWF default plus a 15-point alternative.
export function defaultScoring(): Scoring {
  return {
    systems: [
      { id: 'ps-default', name: 'Default (21)', pointsPerSet: 21, maxPointsPerSet: 30, deciderPoints: 21, deciderMaxPoints: 30 },
      { id: 'ps-15', name: '15 point', pointsPerSet: 15, maxPointsPerSet: 21, deciderPoints: 15, deciderMaxPoints: 21 },
    ],
    defaultId: 'ps-default',
  };
}

export const MatchStatus = z.enum(['pending', 'live', 'done']);
export type MatchStatus = z.infer<typeof MatchStatus>;

// `walkover` records a forfeit: if set, the named side wins the match without
// a real score (status is forced to 'done', score stays []). Standings credit
// a win/loss but no set/point delta. Withdrawing a participant fills this in
// across all their unfinished group matches and KO slots.
export const Walkover = z.union([z.literal('p1'), z.literal('p2'), z.null()]);
export type Walkover = z.infer<typeof Walkover>;

export const Match = z.object({
  id: z.string(),
  p1: z.string(),
  p2: z.string(),
  court: z.string().default(''),
  score: Score.default([]),
  status: MatchStatus.default('pending'),
  walkover: Walkover.default(null),
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
  // null = use the tournament default point system; otherwise a PointSystem id.
  pointSystemId: z.string().nullable().default(null),
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
  walkover: Walkover.default(null),
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
  // null = use the tournament default point system; otherwise a PointSystem id.
  pointSystemId: z.string().nullable().default(null),
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
  // Migrate the earlier flat scoring shape { pointsPerSet, maxPointsPerSet, ... }
  // into the point-system library: the old values become the "Default" system,
  // plus a seeded 15-point alternative.
  const sc = obj.scoring as Record<string, unknown> | undefined;
  if (sc && typeof sc === 'object' && !Array.isArray(sc) && sc.systems === undefined) {
    obj.scoring = {
      systems: [
        { id: 'ps-default', name: 'Default', pointsPerSet: sc.pointsPerSet ?? 21, maxPointsPerSet: sc.maxPointsPerSet ?? 30, deciderPoints: sc.deciderPoints ?? 21, deciderMaxPoints: sc.deciderMaxPoints ?? 30 },
        { id: 'ps-15', name: '15 point', pointsPerSet: 15, maxPointsPerSet: 21, deciderPoints: 15, deciderMaxPoints: 21 },
      ],
      defaultId: 'ps-default',
    };
  }
  // Migrate legacy participant shape { name, club } → { players[] }. Old doubles
  // rows ("A & B") split into two players; the combined `club` is dropped (club
  // is now per-person in `registrants`, re-entered via the UI). Group/bracket
  // references are by participant id, so they keep working.
  if (Array.isArray(obj.participants)) {
    obj.participants = (obj.participants as Record<string, unknown>[]).map((p) => {
      if (p && p.players === undefined && typeof p.name === 'string') {
        const players = p.name.includes(' & ')
          ? p.name.split('&').map(s => s.trim()).filter(Boolean)
          : [p.name.trim()].filter(Boolean);
        const { name: _name, club: _club, ...rest } = p;
        return { ...rest, players: players.length ? players : ['?'] };
      }
      return p;
    });
  }
  return obj;
}, z.object({
  tournament: z.object({
    id: z.string(),
    name: z.string(),
    updatedAt: z.string(),
  }),
  participants: z.array(Participant).default([]),
  // Per-person check-in + fee state, keyed by normalised person name. See Registrant.
  registrants: z.record(z.string(), Registrant).default({}),
  // Point-system library + tournament default. Old files without it get seeded.
  scoring: Scoring.default(defaultScoring),
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
