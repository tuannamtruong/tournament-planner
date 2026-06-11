# Tournament Planner

A small web app for running a badminton-style tournament (~100–500 participants, 2-day event).

Two surfaces, in different places:

- **Result site** — read-only, hosted as static files on **S3 with website hosting enabled**. Two pages: `index.html` (group stage) and `knockout.html` (bracket).
- **Admin site** — runs **locally on the tournament director's laptop** at `http://localhost:37325`. Owns the canonical tournament data as a JSON file. Imports participants, builds groups, runs pairings, enters scores, manages the knockout. On every change it bumps a `pendingChanges` counter; the operator clicks **Force publish** to derive the view JSONs and push them to S3 via an IAM user.

**There is no backend in AWS.** S3 stores static HTML/JS plus a handful of JSON files. No CloudFront, no ACM cert, no Route 53.

> **HTTP-only note:** the S3 website endpoint serves over plain HTTP. Browsers show "not secure" in the address bar. Acceptable for an event with no logins on the result site and no sensitive data. If trust UX matters later, front the bucket with CloudFront + ACM.

## Hard constraints

- **Cost-conscious.** Whole event should cost <$2 in AWS spend (excluding a new domain). Avoid anything that bills per-hour-while-idle.
- **Short-lived.** One event. No multi-tenancy, no long-term migrations, no 10× scale planning.
- **Single operator.** One person, one laptop, owns the source of truth. Scorekeepers at courts relay scores on paper or via a phone/tablet pointed at the operator's laptop over the venue LAN. **This assumption is load-bearing for the whole design — if it breaks, this architecture breaks.**
- **Offline-tolerant.** Venue Wi-Fi may flap. The admin app must accept edits while disconnected; the operator clicks **Force publish** once connectivity returns to push the accumulated state.

## Features

### Admin (`http://localhost:37325`)

Single-page UI with tabbed sections in `admin/public/index.html`:

- **Participants** — add by form; paste CSV (columns `name, club, category, class, seed`); remove with confirmation. `category` is one of `MS | WS | MD | WD | MX`; `class` is one of `S | A | B | C | D` (skill bracket). Doubles entries are stored as a single row with both names joined by ` & ` and combined clubs.
- **Groups** — create with `round_robin | swiss | manual` mode plus a single `category` and zero or more `classes` (multi-select; empty = any). The Add/remove-members checklist only shows participants whose `category` matches and whose `class` is in the group's class list, and hides anyone already assigned to a different group. Current members of this group always appear in their own checklist so ticking never makes a row disappear, and the panel keeps its open/closed state across the refresh triggered by each tick.
- **Pairings** — for round-robin / Swiss groups, one button generates the next round respecting history (Swiss won't repeat opponents; round-robin walks the circle-method schedule).
- **Scoring** — best-of-3 set scores per match, with court label, **▶ live** / **✓ done** buttons that auto-stamp `startedAt` / `finishedAt`. For `manual` groups, an inline form adds matches between any two members in any round.
- **Bracket** — create a 4/8/16/32-slot knockout, seeded from participants' `seed` field (standard 1-vs-N-, 4-vs-N-3-style positions). Enter set scores in a slot and click the winner; the winner is auto-propagated to the next round's slot.
- **Settings** — rename the tournament. Manual **Push backup snapshot** button. Live JSON dump of the publish-status object for debugging.
- **Header status light** — 🟢 synced / 🟡 pending or pushing / 🟡 "AWS not configured" / 🔴 push failed (no auto-retry — click again). **Force publish** button next to it.

### Result site (S3)

- **`index.html`** — one block per group: pre-computed standings table (rank, W, L, sets, points) + match grid (court, names, set scores, status).
- **`knockout.html`** — column-per-round bracket, winner names bolded, set scores beneath.
- Both pages poll `data/version.json` every 15 s. When `updatedAt` changes, they refetch only the view file they render. No CDN; browser `Cache-Control` does the work.


## Pairing modes

Strategy interface: `generateNextRound(group) → Round` in `admin/src/pairing/index.ts`.

- **Round robin** (`round_robin.ts`) — circle method. N members → N-1 rounds (even) or N rounds (odd, with byes). Fully deterministic.
- **Swiss** (`swiss.ts`) — rank by current points (wins so far), pair greedily with backtracking, never repeat an opponent. Lowest-ranked unbyed player gets the bye on odd counts; falls back to last player if everyone has had a bye. Throws if no rematch-free pairing exists.
- **Manual** — admin adds matches via the inline form in Scoring; no auto-generation.

`generateNextRound()` for Swiss derives each player's `{ points, opponents, hadBye }` from the group's `rounds` history before delegating to the algorithm.