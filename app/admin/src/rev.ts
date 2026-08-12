// Per-record optimistic-concurrency helpers.
//
// Every record that two operators might edit at once (matches, bracket slots,
// participants, groups, brackets, registrants) carries { rev, updatedAt,
// lastEditor } — see revisionFields in schema.ts. A route's mutator calls
// touch() on exactly the record(s) it changed; this bumps the per-record
// counter and stamps who/when. The counter is what an editing client echoes
// back as `baseRev`, and what assertRev() checks to reject a stale write with
// a 409 Conflict. It's also the basis of the cross-laptop merge (merge.ts).

export type Revisioned = { rev?: number; updatedAt?: string; lastEditor?: string };

// This laptop's identity, stamped into lastEditor so a conflict can name which
// operator's edit won/lost. Defaults to the OS hostname when TP_NODE_ID is unset.
export const NODE_ID =
  process.env.TP_NODE_ID || process.env.HOSTNAME || 'local';

// Bump a record's revision after mutating it. Returns the same object (now
// carrying rev/updatedAt/lastEditor) for chaining into push(). Constrained on
// `object` rather than `Revisioned` so a record literal that doesn't yet list
// the optional rev fields still infers its own type (an all-optional constraint
// otherwise makes TS fall back to inferring T = Revisioned and lose the type).
export function touch<T extends object>(record: T, at = new Date().toISOString()): T & Revisioned {
  const r = record as T & Revisioned;
  r.rev = (r.rev ?? 0) + 1;
  r.updatedAt = at;
  r.lastEditor = NODE_ID;
  return r;
}

/** Raised when a write targets a record whose rev has moved on (lost update). */
export class ConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string, readonly current: unknown) {
    super(message);
    this.name = 'ConflictError';
  }
}

/**
 * Optimistic-concurrency guard. If the caller supplied the rev it read
 * (`baseRev`) and the record has since advanced, throw a ConflictError carrying
 * the current record so the client can reload + notify. A missing baseRev means
 * the caller opted out of OCC (e.g. legacy clients) — the write proceeds.
 */
export function assertRev(record: Revisioned, baseRev: number | undefined, label: string): void {
  if (baseRev === undefined) return;
  if ((record.rev ?? 0) !== baseRev) {
    throw new ConflictError(
      `${label} was changed by ${record.lastEditor || 'another operator'} — reload and re-enter.`,
      record,
    );
  }
}
