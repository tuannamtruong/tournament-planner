# Tournament Planner

A small web app for running a badminton-style tournament (~100–500 participants, 2-day event).

Two surfaces, in different places:

- **Result site** — read-only, hosted as static files on **S3 with website hosting enabled**. Two pages: `index.html` (group stage) and `knockout.html` (bracket).
- **Admin site** — runs **locally on each operator's laptop** at `http://localhost:37325`. Holds a local copy of the tournament data as a JSON file. Imports participants, builds groups, runs pairings, enters scores, manages the knockout. On every change it bumps a `pendingChanges` counter; the operator clicks **Publish** to derive the view JSONs and push them to S3 via an IAM user.

**No compute backend in AWS** — no servers, CloudFront, ACM, or Route 53. S3 stores static HTML/JS, the public view JSONs, and (when multi-operator sync is configured) the **canonical `tournament.json` under a private prefix**. Multiple operator laptops stay in step optimistically (no locks) via S3 **conditional writes** (`If-Match`/ETag), with per-record revisions and a 3-way merge. See "Multi-operator sync" below. S3 object GET/PUT only, so cost stays within budget.

> **Repo layout:** the entire runnable project lives under **`app/`** (`app/admin/`, `app/result-site/`, `app/scripts/`, `app/tests/`, `app/deploy/`, plus `package.json`, `Makefile`, `.env`). Only `README.md`, `CLAUDE.md`, and `docs/` sit at the repo root. Run all `pnpm`/`make` commands from `app/` (`cd app`, or `pnpm --prefix app …` / `make -C app …`). Paths below are written relative to the repo root, i.e. prefixed with `app/`.

> **HTTP-only note:** the S3 website endpoint serves over plain HTTP. Browsers show "not secure" in the address bar. Acceptable for an event with no logins on the result site and no sensitive data. If trust UX matters later, front the bucket with CloudFront + ACM.

## Hard constraints

- **Cost-conscious.** Whole event should cost <$2 in AWS spend (excluding a new domain). Avoid anything that bills per-hour-while-idle.
- **Short-lived.** One event. No multi-tenancy, no long-term migrations, no 10× scale planning.
- **Multiple operators, optimistic, no locks.** Several operators may edit at once, each on their own laptop. There is no live coordination server: S3 holds the canonical state and laptops reconcile through it with conditional-write OCC. Conflicts are detected **per record** (two scorekeepers editing different matches never collide) and resolved last-write-wins with a flag; concurrent edits to the *same* record surface a reload+notify. Scorekeepers at courts may still relay scores on paper or via a phone/tablet pointed at any operator's laptop over the venue LAN.
- **Offline-tolerant.** Venue Wi-Fi may flap. Each admin app accepts edits while disconnected; they queue locally and reconcile (per-record last-write-wins) when connectivity returns. **Publish** likewise pushes the accumulated view JSONs once back online.

## Features

### Admin (`http://localhost:37325`)

Single-page UI with tabbed sections in `app/admin/public/index.html`:

- **Participants** — add by form; paste CSV (columns `name, club, category, class, seed`); remove with confirmation. `category` is one of `MS | WS | MD | WD | MX`; `class` is one of `S | A | B | C | D` (skill bracket). Doubles entries are stored as a single row with both names joined by ` & ` and combined clubs.
- **Groups** — create with `round_robin | swiss | manual` mode plus a single `category` and zero or more `classes` (multi-select; empty = any). The Add/remove-members checklist only shows participants whose `category` matches and whose `class` is in the group's class list, and hides anyone already assigned to a different group. Current members of this group always appear in their own checklist so ticking never makes a row disappear, and the panel keeps its open/closed state across the refresh triggered by each tick.
- **Pairings** — for round-robin / Swiss groups, one button generates the next round respecting history (Swiss won't repeat opponents; round-robin walks the circle-method schedule).
- **Scoring** — best-of-3 set scores per match, with court label, **▶ live** / **✓ done** buttons that auto-stamp `startedAt` / `finishedAt`. For `manual` groups, an inline form adds matches between any two members in any round.
- **Bracket** — create a 4/8/16/32-slot knockout, seeded from participants' `seed` field (standard 1-vs-N-, 4-vs-N-3-style positions). Enter set scores in a slot and click the winner; the winner is auto-propagated to the next round's slot.
- **Pending** — every state-changing API call appends an entry to `app/admin/data/pending.json` along with a full pre-mutation snapshot of `tournament.json`. The tab lists those entries newest-first with a server-rendered summary.
- **Settings** — rename the tournament. Manual **Push backup snapshot** button. Live JSON dump of the publish-status object for debugging.
- **Header status lights** — two indicators. (1) **Sync** (multi-operator): 🟢 in-sync · `nodeId` / 🟡 sync offline / 🔴 N sync conflict(s); hidden when sync isn't configured. Conflicts also pop a toast. (2) **Publish** (result site): 🟢 synced / 🟡 pending or pushing / 🟡 "AWS not configured" / 🔴 push failed (no auto-retry — click again), with the **Publish** button.

### Result site (S3)

- **`index.html`** — one block per group: pre-computed standings table (rank, W, L, sets, points) + match grid (court, names, set scores, status).
- **`knockout.html`** — column-per-round bracket, winner names bolded, set scores beneath.
- Both pages fetch `data/version.json` once on page load, then fetch the view file they render. No auto-polling — spectators must refresh or reopen the page to see new data. No CDN; browser `Cache-Control` does the work.


## Pairing modes

Strategy interface: `generateNextRound(group) → Round` in `app/admin/src/pairing/index.ts`.

- **Round robin** (`round_robin.ts`) — circle method. N members → N-1 rounds (even) or N rounds (odd, with byes). Fully deterministic.
- **Swiss** (`swiss.ts`) — rank by current points (wins so far), pair greedily with backtracking, never repeat an opponent. Lowest-ranked unbyed player gets the bye on odd counts; falls back to last player if everyone has had a bye. Throws if no rematch-free pairing exists.
- **Manual** — admin adds matches via the inline form in Scoring; no auto-generation.

`generateNextRound()` for Swiss derives each player's `{ points, opponents, hadBye }` from the group's `rounds` history before delegating to the algorithm.

## Multi-operator sync

Optional, optimistic, non-blocking sync so several operators can edit one tournament from separate laptops. Off by default (single-laptop behaviour unchanged); enabled by configuring a shared store.

- **Per-record revisions.** Match, bracket slot, participant, group, bracket and registrant records each carry `{ rev, updatedAt, lastEditor }` (see `revisionFields` in `app/admin/src/schema.ts`). `touch()` in `app/admin/src/rev.ts` bumps `rev` on every modification; a global `tournament.rev` bumps on every `mutate()`.
- **Optimistic concurrency (OCC).** Edit requests for the hot paths (group match `PATCH`, bracket slot `PATCH`, participant + registrant `PATCH`) carry a `baseRev`. If it no longer matches, the route throws `ConflictError` (`rev.ts`) → HTTP **409** with the current record. The admin UI catches it (`saveEdit` in `app.js`) and does a **reload + notify** (toast), never clobbering.
- **Live updates.** The admin polls `GET /api/state/rev` (~2 s) and re-fetches when the global rev changes, so other operators' edits appear without a manual refresh.
- **Canonical store + merge.** `app/admin/src/sync.ts` keeps a canonical `tournament.json` in S3 (private prefix) in step using conditional `PutObject` (`If-Match`/ETag). Each tick: pull → `merge(base, local, remote)` (`app/admin/src/merge.ts`, a 3-way per-record merge; base = last-synced state, persisted as `sync-base.json`) → write merged locally → push with `If-Match`; on 412 it re-pulls. Disjoint edits combine cleanly; same-record conflicts are last-write-wins by `updatedAt` and reported via `GET /api/sync/status` (acked with `POST /api/sync/conflicts/ack`). Offline pulls/pushes fail soft and retry.
- **Config (`app/.env`).** `TP_NODE_ID` (per-laptop label), `TP_STATE_KEY` (default `private/state/tournament.json`), `TP_SYNC_INTERVAL_MS`. **`TP_SYNC_DIR`** selects a `FilesystemStore` (one shared folder, same If-Match contract) instead of S3 — zero AWS, used by `app/tests/sync.test.mjs` and handy for local two-laptop testing. All laptops share one operator key (`tp-operator`); the CloudFormation publisher policy grants `s3:GetObject`/`s3:PutObject` on `private/state/*`.