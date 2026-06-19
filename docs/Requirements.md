# Requirements — Tournament Planner

> Requirements document for the **existing** system. This is a reverse-spec: it
> describes what the shipped app does and the constraints it was built under, so
> a new contributor (or the operator) can judge a change against the original
> intent. For *how* each feature behaves in detail, see
> [Features.md](Features.md); for the rationale behind the architecture, see
> [Architecture.md](Architecture.md).

## 1. Purpose & scope

Run a single badminton-style tournament end to end: import the entry list, draw
groups, generate pairings, record scores, run knockout brackets, and publish a
read-only result page that spectators can open on their phones.

- **In scope:** one event, ~100–500 participants, two days, one operator.
- **Out of scope:** multi-tenancy, user accounts, long-term data retention,
  10× scale, live push/auto-refresh to spectators, payments, registration
  portal.

## 2. Stakeholders (roles)

| Role | Responsibility | AWS credentials |
|---|---|---|
| **Dev** | Builds/maintains code and infra; produces the portable Windows bundle. | Account-admin (stays on dev machine). |
| **Admin** | Installs the bundle on the operator's laptop, fills `.env`, smoke-tests the public URL. | None. |
| **Operator / Publisher** | Runs the admin app during the event and clicks **Publish**. | `tp-publisher` key, `s3:PutObject` on `data/*` only. |
| **Viewer** | Players & spectators with the public URL. | None. |

At a small event these can collapse onto one person, but the responsibilities
stay distinct.

## 3. Hard constraints (load-bearing)

These are non-negotiable design constraints; relaxing any of them changes the
architecture.

- **C1 — Cost-conscious.** Whole event must cost **< $2** in AWS spend
  (excluding a domain). Nothing that bills per-hour-while-idle.
- **C2 — Short-lived.** One event. No migrations, no multi-tenancy, no scale
  planning.
- **C3 — Single operator, single laptop.** One person owns the source of truth.
  No concurrent editing, no multi-admin.
- **C4 — Offline-tolerant.** Venue Wi-Fi may flap. The admin app must accept
  edits while disconnected and flush them on a later **Publish**.
- **C5 — No AWS backend.** S3 stores static HTML/JS + a few JSON files. No
  CloudFront, ACM, Route 53, Lambda, or database.

## 4. Functional requirements

### 4.1 Participants
- **FR-P1** Add a participant by form: `name` (required), `club`, `category`
  (`MS|WS|MD|WD|MX`), `class` (`S|A|B|C|D`), `seed`.
- **FR-P2** Bulk import via pasted CSV (`name, club, category, class, seed`,
  header row required).
- **FR-P3** Edit and remove participants; removal also strips the participant
  from every group's member list and asks for confirmation.
- **FR-P4** Doubles entries are stored as one row with both names joined by
  ` & ` and combined clubs.
- **FR-P5** A participant can be **withdrawn**; this fills a walkover across all
  their unfinished group matches and knockout slots.

### 4.2 Groups
- **FR-G1** Create a group with a `mode` (`round_robin | swiss | manual`), one
  `category`, and zero or more `classes` (empty = any class).
- **FR-G2** The member picker only offers participants matching the group's
  category + class and **not already in another group** (group membership is
  exclusive). Current members always remain visible.
- **FR-G3** Standings are computed per group with a fixed tiebreaker order:
  wins → set difference → point difference → head-to-head.
- **FR-G4** Withdrawn players sort to the bottom of the standings table.

### 4.3 Pairings
- **FR-PR1** Round-robin: generate the full circle-method schedule
  (N−1 rounds for even N, N rounds with byes for odd N). Deterministic.
- **FR-PR2** Swiss: generate the next round by current points, never repeating
  an opponent, with a bye for the lowest-ranked unbyed player on odd counts.
  Errors if no rematch-free pairing exists.
- **FR-PR3** Manual: no auto-generation; the operator adds matches between any
  two members in any round via an inline form.
- **FR-PR4** Pairing/standings logic lives only in `admin/src/` and runs at
  publish time; the result site never recomputes it.

### 4.4 Scoring
- **FR-S1** Enter best-of-3 (up to 5) set scores per match, plus a court label.
- **FR-S2** **▶ live** / **✓ done** buttons auto-stamp `startedAt` /
  `finishedAt`.
- **FR-S3** Record a walkover (forfeit): the named side wins, status forced to
  `done`, no set/point delta credited.
- **FR-S4** A "Live now" panel surfaces in-progress matches across all groups.

### 4.5 Knockout brackets
- **FR-K1** Create one or more brackets, each scoped to a category + classes,
  with a player count of any integer ≥ 2.
- **FR-K2** Non-power-of-2 counts round up to the next power of 2; unfilled
  positions are seated as **BYE** and auto-advance the lone player.
- **FR-K3** Seed positions from participants' `seed` field (standard
  1-vs-N seeding).
- **FR-K4** Enter set scores in a slot and pick the winner; the winner
  auto-propagates to the correct slot in the next round.

### 4.6 Publish & offline
- **FR-PUB1** Every state-changing API call appends a pre-mutation snapshot +
  audit entry to `admin/data/pending.json` and bumps a `pendingChanges`
  counter.
- **FR-PUB2** A header **status light** shows synced / pending / pushing / not-
  configured / failed state.
- **FR-PUB3** **Publish** derives `version.json`, `groups.json`,
  `knockout.json` and PUTs them to S3; on success the pending log clears. No
  auto-retry — the operator clicks again.
- **FR-PUB4** Edits succeed while offline; the operator publishes the
  accumulated state when connectivity returns.

### 4.7 Pending / undo
- **FR-U1** The Pending tab lists every unpublished change newest-first with a
  server-rendered, human-readable summary.
- **FR-U2** **Revert from here** restores the snapshot just before a chosen
  entry and discards every later change (linear undo). **Revert all** restores
  the last-published baseline.

### 4.8 Backups
- **FR-B1** A local snapshot is written to `admin/data/backups/` every 5
  minutes (last 50 kept).
- **FR-B2** A manual **Push backup snapshot** button PUTs a full
  `tournament.json` to `private/backups/` on S3 (denied to public read).

### 4.9 Result site (spectator)
- **FR-R1** `index.html`: one block per group with a pre-computed standings
  table + match grid.
- **FR-R2** `knockout.html`: column-per-round bracket, winners bolded, set
  scores beneath.
- **FR-R3** Pages fetch `data/version.json` on load, then the view file. **No
  auto-polling** — spectators refresh to see new data.

## 5. Non-functional requirements

- **NFR-1 (cost)** ≤ $2 per event — see [Cost-analysis.md](Cost-analysis.md).
- **NFR-2 (no build step)** Plain HTML + vanilla JS on both surfaces; `tsx`
  runs the TypeScript server directly.
- **NFR-3 (durability)** All writes go through `storage.mutate()`: zod-validate
  → temp file → atomic rename. The JSON file is human-inspectable in an
  emergency.
- **NFR-4 (least privilege)** The publisher IAM user has `s3:PutObject` scoped
  to `data/*` only; the `private/*` prefix is non-public.
- **NFR-5 (recoverability)** The operator can restore from an S3 backup onto a
  fresh checkout (verified in the [Production checklist](Production-checklist.md)).
- **NFR-6 (mobile)** The result site must render on a phone; most spectators
  view on mobile.
- **NFR-7 (security posture)** Result site is plain HTTP (S3 website endpoint);
  acceptable because there are no logins and no sensitive data.

## 6. Data model (source of truth)

One file, `admin/data/tournament.json`, validated by
[`admin/src/schema.ts`](../admin/src/schema.ts):

```
Tournament
 ├─ tournament { id, name, updatedAt }
 ├─ participants[]  { id, name, club, category, class, seed, withdrawn }
 ├─ groups[]        { id, name, mode, category, classes[], members[], rounds[] }
 │                    rounds[] → { roundNo, matches[] }
 │                    matches[] → { id, p1, p2, court, score[][], status, walkover, startedAt, finishedAt }
 ├─ knockouts[]     { id, name, category, classes[], size, rounds[] }
 │                    rounds[] → { roundNo, name, slots[] }
 │                    slots[] → { slot, p1, p2, matchId, court, score, status, walkover, winner, startedAt, finishedAt }
 └─ auditLog[]      { ts, action, target, payload }
```

`category` and `class` are **open strings** (UI constrains the common ones via
selects) so the operator can add ad-hoc values. A legacy single `knockout`
field is migrated to a one-element `knockouts` array on read.

## 7. Assumptions & risks

- **Single-writer assumption is load-bearing (C3).** If two people edit two
  laptops, their JSON files diverge and the last Publish wins silently.
- **Spectators must refresh** — there is no live update by design (cost + no
  server). A stale tab shows stale data until reload.
- **No auto-retry on publish failure** — relies on the operator watching the
  status light and re-clicking.
- **HTTP-only result site** shows "not secure"; accepted per NFR-7.
