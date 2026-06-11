# Tournament Planner

A small web app for running a badminton-style tournament (~100–500 participants, 2-day event).

Two surfaces, in different places:

- **Result site** — read-only, hosted as static files on **S3 with website hosting enabled**. Accessed via the auto-generated endpoint, e.g. `http://tp-result-<sfx>.s3-website.eu-central-1.amazonaws.com` (HTTP only, no custom domain, no CDN). Two pages: `index.html` (group stage) and `knockout.html` (bracket).
- **Admin site** — runs **locally on the tournament director's laptop** at `http://localhost:37325`. Owns the canonical tournament data as a JSON file. Imports participants, builds groups, runs pairings, enters scores, manages the knockout. On every change it derives view JSONs and pushes them to S3 using an IAM user.

**There is no backend in AWS.** S3 stores static HTML/JS plus a handful of JSON files. No CloudFront, no ACM cert, no Route 53.

> **HTTP-only note:** the S3 website endpoint serves over plain HTTP. Browsers show "not secure" in the address bar. Acceptable for an event with no logins on the result site and no sensitive data. If trust UX matters later, front the bucket with CloudFront + ACM.

## Hard constraints

- **Cost-conscious.** Whole event should cost <$2 in AWS spend (excluding a new domain). Avoid anything that bills per-hour-while-idle.
- **Short-lived.** One event. No multi-tenancy, no long-term migrations, no 10× scale planning.
- **Single operator.** One person, one laptop, owns the source of truth. Scorekeepers at courts relay scores on paper or via a phone/tablet pointed at the operator's laptop over the venue LAN. **This assumption is load-bearing for the whole design — if it breaks, this architecture breaks.**
- **Offline-tolerant.** Venue Wi-Fi may flap. The admin app must accept edits while disconnected and flush pushes to S3 once connectivity returns.

## Features

### Admin (`http://localhost:37325`)

Single-page UI with tabbed sections in `admin/public/index.html`:

- **Participants** — add by form; paste CSV (columns `name, club, category, class, seed`); remove with confirmation. `category` is one of `MS | WS | MD | WD | MX`; `class` is one of `S | A | B | C | D` (skill bracket). Doubles entries are stored as a single row with both names joined by ` & ` and combined clubs.
- **Groups** — create with `round_robin | swiss | manual | table` mode plus a single `category` and zero or more `classes` (multi-select; empty = any). The Add/remove-members checklist only shows participants whose `category` matches and whose `class` is in the group's class list, and hides anyone already assigned to a different group. Current members of this group always appear in their own checklist so ticking never makes a row disappear, and the panel keeps its open/closed state across the refresh triggered by each tick.
- **Pairings** — for round-robin / Swiss groups, one button generates the next round respecting history (Swiss won't repeat opponents; round-robin walks the circle-method schedule).
- **Scoring** — best-of-3 set scores per match, with court label, **▶ live** / **✓ done** buttons that auto-stamp `startedAt` / `finishedAt`. For `manual` / `table` groups, an inline form adds matches between any two members in any round.
- **Bracket** — create a 4/8/16/32-slot knockout, seeded from participants' `seed` field (standard 1-vs-N-, 4-vs-N-3-style positions). Enter set scores in a slot and click the winner; the winner is auto-propagated to the next round's slot.
- **Settings** — rename the tournament. Manual **Push backup snapshot** button. Live JSON dump of the publish-status object for debugging.
- **Header status light** — 🟢 synced / 🟡 queued or pushing / 🟡 "AWS not configured" / 🔴 push failed (retrying). **Force publish** button next to it.

### Result site (S3)

- **`index.html`** — one block per group: pre-computed standings table (rank, W, L, sets, points) + match grid (court, names, set scores, status).
- **`knockout.html`** — column-per-round bracket, winner names bolded, set scores beneath.
- Both pages poll `data/version.json` every 15 s. When `updatedAt` changes, they refetch only the view file they render. No CDN; browser `Cache-Control` does the work.

## Architecture

```
[Director's laptop]
  Node + Fastify on localhost:37325
   ├─ admin browser UI (admin/public/)
   ├─ admin/data/tournament.json   ← single source of truth
   ├─ pairing engine (round_robin / swiss / manual)
   ├─ standings engine (tiebreaker authority)
   └─ AWS SDK ──► S3 PUT on every change (debounced 500 ms)
                              │
                              ▼
                  ┌──────────────────────────────────────────────┐
                  │ S3 bucket: tp-result-<sfx>                   │
                  │ (website hosting enabled, public read on     │
                  │  index/knockout/assets/data only)            │
                  │  index.html, knockout.html  Cache-Control 1h │
                  │  assets/app.css, *.js       Cache-Control 1h │
                  │  data/groups.json           Cache-Control 15s│
                  │  data/knockout.json         Cache-Control 15s│
                  │  data/version.json          Cache-Control 5s │
                  │  private/backups/*.json     (denied to web)  │
                  └──────────────────────────────────────────────┘
                              ▲
                              │ plain HTTP, browser-cached per Cache-Control
                  [Public spectators' browsers]
```

### Why this shape

| Decision | Why | Alternative considered |
|---|---|---|
| Admin runs locally | No server to host, no admin auth needed, pairing logic just runs in Node, the DB is a file on the laptop | Hosted admin on Lightsail (~$3.50/mo, +Caddy +cookies +systemd +backups) — strictly more parts |
| JSON file as source of truth | Single writer, <10 MB of data, trivial to inspect/edit in an emergency, same shape that gets pushed to S3 | SQLite: nicer queries, but adds a transform step before publishing and a native dep |
| S3 website hosting, no CDN, no custom domain | Cheapest possible; zero servers; no DNS/cert setup; result-site URL is just the bucket endpoint | CloudFront + ACM + custom domain: prettier URL and HTTPS, but adds 3 services to provision and is unnecessary for one event |
| Poll `version.json` for updates | Cacheable, cheap, no SSE infrastructure, survives reconnects | SSE: needs a long-lived server we don't have anymore |
| IAM user with `s3:PutObject` only | Least-privilege, keys live in `~/.aws/credentials` on the laptop | IAM role: only for EC2/Lambda; not applicable to a laptop |
| Plain HTML + vanilla JS (no build) | ~8 screens total; React/Vite tax doesn't pay back | React+Vite: more dev tax than payoff at this scale |

## Tech stack

- **Runtime:** Node 20 LTS (laptop only). System Node 18 works for tests but the AWS SDK warns; use 20 in production.
- **Local admin server:** Fastify 4, zod (validation), @fastify/static, `@aws-sdk/client-s3`, nanoid (IDs), csv-parse (import).
- **Local persistence:** one `tournament.json` file, atomic write via temp-file + rename, in-memory cache, serialized writes via a promise chain.
- **Admin UI:** plain HTML + vanilla JS ES modules + one CSS file. No build step. No framework.
- **Public UI:** same — plain HTML + vanilla JS, uploaded as-is to S3.
- **Tests:** Vitest. 13 tests covering pairing (round-robin completeness/byes/determinism, Swiss no-rematch + bye-rotation) and standings tiebreakers. **All passing.**
- **TS execution:** `tsx` runs `.ts` directly; no compile step. `tsconfig.json` is `noEmit`, used only for IDE typing.

## File structure

```
admin/                          local Node app (NEVER hosted on AWS)
  src/
    index.ts                    Fastify boot; serves admin UI + /api; onResponse hook → schedulePublish
    schema.ts                   zod schemas for the entire JSON shape
    storage.ts                  load/mutate/save with atomic temp+rename, serialized writes, local snapshots
    standings.ts                tiebreaker authority (W → set diff → point diff → h2h)
    publish.ts                  view derivation + debounced S3 PUT + retry/backoff + hourly backups
    pairing/
      round_robin.ts            circle method
      round_robin.test.ts
      swiss.ts                  greedy with backtracking, no rematches
      swiss.test.ts
      index.ts                  per-group dispatch (history → players → pairing → Round materialization)
    routes/
      state.ts                  GET /api/state, PUT /api/state/name
      participants.ts           POST/PATCH/DELETE + CSV import
      groups.ts                 POST/PATCH/DELETE + POST :id/next-round
      matches.ts                PATCH score/status/court + POST manual match
      knockout.ts               POST bracket, PATCH slot (auto-propagate winner), DELETE
      publish.ts                GET status, POST force, POST backup
  public/                       served by Fastify at /
    index.html                  one page, tabbed sections, status light
    assets/
      app.css
      api.js                    tiny fetch wrapper
      app.js                    all UI logic, 2 s status polling
  data/                         gitignored
    tournament.json             source of truth (created on first run from seed)
    backups/                    rolling local snapshots (every 5 min, keep last 50)
admin/src/standings.test.ts     tiebreaker tests

scripts/                        one-off node scripts run via `npx tsx`
  import-ettlingen.ts           bulk-seed participants from the Ettlingen
                                Teilnehmerliste (193 rows; appends — wipe
                                admin/data/ before re-running)
  migrate-split-category.ts     migration that split combined "WS-B" codes
                                into (category, class) and renamed XD → MX;
                                idempotent (skips rows already split)

result-site/                    static files uploaded to S3 (rarely change);
                                also mounted by the admin app at /view/ for
                                same-origin local preview against live data
  index.html                    group stage view
  knockout.html                 knockout bracket view
  assets/
    app.css
    poll.js                     polls data/version.json every 15 s; refetches view file on bump
    render-groups.js
    render-knockout.js

deploy/
  bootstrap-aws.sh              one-shot: bucket + website hosting + IAM user + access key (idempotent)
  publish-static.sh             aws s3 sync result-site/ s3://<bucket>/
  tear-down.sh                  interactive cleanup (empty bucket, delete user)
  s3-bucket-policy.json         public-read for index/knockout/assets/data only
  iam-policy.json               PutObject + DeleteObject scoped to one bucket

package.json                    scripts: dev, start, test, publish-static, bootstrap, tear-down
tsconfig.json                   noEmit; used only for IDE typing
vitest.config.ts
.env.example                    TP_BUCKET, TP_REGION, AWS_PROFILE, PORT
.gitignore
```

## Data model

The single file `admin/data/tournament.json` is the source of truth. zod-validated at load and save time.

```jsonc
{
  "tournament": {
    "id": "tp-mq6vbnok",                       // generated on first run
    "name": "New Tournament",                  // editable in Settings
    "updatedAt": "2026-06-09T18:42:11Z"        // bumped on every mutation
  },
  "participants": [
    // category ∈ MS|WS|MD|WD|MX, class ∈ S|A|B|C|D (both open strings; UI
    // constrains common values via selects). Doubles entries store both
    // names in a single row, e.g. name: "Jane Doe & Erin Roe".
    { "id": "p1", "name": "Jane Doe", "club": "TV Karlsruhe", "category": "WS", "class": "B", "seed": 1, "withdrawn": false }
  ],
  "groups": [
    {
      "id": "g1",
      "name": "Group A",
      "mode": "round_robin",                   // 'round_robin' | 'swiss' | 'manual' | 'table'
      "category": "WS",                        // single category; '' = any
      "classes": ["A", "B"],                   // one or more classes; [] = any
      "members": ["p1", "p2", "p3", "p4"],
      "rounds": [
        {
          "roundNo": 1,
          "matches": [
            {
              "id": "m1",
              "p1": "p1", "p2": "p2",          // or "__bye__" for a Swiss/RR bye
              "court": "1",
              "score": [[21,18],[19,21],[21,15]],
              "status": "done",                // 'pending' | 'live' | 'done'
              "startedAt": "...", "finishedAt": "..."
            }
          ]
        }
      ]
    }
  ],
  "knockout": {
    "size": 16,
    "rounds": [
      {
        "roundNo": 1,
        "slots": [
          {
            "slot": 1,
            "p1": "p1", "p2": "p16",
            "matchId": "k1",
            "score": [[21,15],[21,17]],
            "winner": "p1"                     // propagates to next round's slot on save
          }
        ]
      }
    ]
  },
  "auditLog": [
    { "ts": "...", "action": "score_update", "target": "m1", "payload": { /* ... */ } }
  ]
}
```

### Derived view files (the only thing that reaches S3)

- `data/version.json` — `{ updatedAt, name }`. Polled every 15 s. `Cache-Control: max-age=5`.
- `data/groups.json` — `{ tournament, groups: [...] }` with **pre-computed standings** and match grids (names, not IDs). `Cache-Control: max-age=15`.
- `data/knockout.json` — bracket with names + scores; `null` if no bracket. `Cache-Control: max-age=15`.

`tournament.json` itself is **never** pushed to public S3 — only derived views, so `auditLog` and other internal fields stay private. Hourly full snapshots go to `private/backups/`, denied from public read by the bucket policy.

Standings tiebreakers (badminton convention): **match wins → set difference → point difference → head-to-head**.

## Pairing modes

Strategy interface: `generateNextRound(group) → Round` in `admin/src/pairing/index.ts`.

- **Round robin** (`round_robin.ts`) — circle method. N members → N-1 rounds (even) or N rounds (odd, with byes). Fully deterministic.
- **Swiss** (`swiss.ts`) — rank by current points (wins so far), pair greedily with backtracking, never repeat an opponent. Lowest-ranked unbyed player gets the bye on odd counts; falls back to last player if everyone has had a bye. Throws if no rematch-free pairing exists.
- **Manual** — admin adds matches via the inline form in Scoring; no auto-generation.

`generateNextRound()` for Swiss derives each player's `{ points, opponents, hadBye }` from the group's `rounds` history before delegating to the algorithm.

## HTTP API

All responses are JSON. State-changing requests trigger `schedulePublish()` via a Fastify `onResponse` hook (except `/api/publish/*` itself).

### State
- `GET    /api/state` — full tournament JSON
- `PUT    /api/state/name` `{ name }`

### Participants
- `POST   /api/participants` `{ name, club?, category?, class?, seed? }`
- `PATCH  /api/participants/:id` `{ name?, club?, category?, class?, seed?, withdrawn? }`
- `DELETE /api/participants/:id` — also removes from all `group.members`
- `POST   /api/participants/import-csv` `{ csv }` — columns: `name, club, category, class, seed` (header row required; lowercase or capitalized accepted)

### Groups
- `POST   /api/groups` `{ name, mode, category?, classes?, members? }` — `classes` is an array of class codes; empty array means "any class"
- `PATCH  /api/groups/:id` — partial of `{ name, mode, category, classes, members }`
- `DELETE /api/groups/:id`
- `POST   /api/groups/:id/next-round` — generate via the group's `mode`; throws on `manual`/`table` and on schedule-complete

### Matches
- `PATCH  /api/groups/:gid/matches/:mid` `{ score?, status?, court? }` — auto-stamps `startedAt` on first `live`, `finishedAt` on first `done`
- `POST   /api/groups/:gid/matches` `{ p1, p2, court?, roundNo? }` — manual/table groups; round is created if absent

### Knockout
- `POST   /api/knockout` `{ size, seeds? }` — creates an empty bracket of the given size and fills round 1 by standard single-elim seeding from the `seeds` array
- `PATCH  /api/knockout/round/:r/slot/:s` `{ p1?, p2?, score?, winner? }` — setting `winner` propagates to the next round's correct slot (odd slot → p1, even → p2)
- `DELETE /api/knockout`

### Publish
- `GET    /api/publish/status` — `{ configured, lastSuccess, lastError, pendingChanges, inFlight, nextRetryAt }`
- `POST   /api/publish/force` — cancels any pending debounce/retry and pushes synchronously; 502 with error message on failure
- `POST   /api/publish/backup` — manual push of `tournament.json` snapshot to `private/backups/`

### Local viewer (dev preview of the result site)
- `GET    /view/`, `/view/index.html`, `/view/knockout.html`, `/view/assets/*` — static mount of `result-site/`
- `GET    /view/data/version.json` — same shape as the S3 file, derived live from `tournament.json`; `Cache-Control: max-age=5`
- `GET    /view/data/groups.json` — derived live; `Cache-Control: max-age=15`
- `GET    /view/data/knockout.json` — derived live (returns `null` if no bracket); `Cache-Control: max-age=15`

## Development workflow

```bash
pnpm i                # or: npm i

# Run the local admin app
pnpm dev              # tsx watch admin/src/index.ts → http://localhost:37325

# Preview the result site against live data (no S3 needed)
# The admin app mounts `result-site/` at /view/ and serves the same derived
# view JSONs (version/groups/knockout) at /view/data/*.json that the publish
# loop would push to S3. Same-origin, same shape, same Cache-Control headers —
# the only thing that's different is the URL.
#   open http://localhost:37325/view/           # spectator's index.html
#   open http://localhost:37325/view/knockout.html
# Updates appear on the next 15 s poll after each admin edit. No S3, no
# fixture files to maintain.

# Tests
pnpm test             # vitest — pairing + standings (13 tests)
```

No build step anywhere. Edit a file, reload the page.

`admin/data/tournament.json` is created on first run from a seed template. To wipe: delete the file (or the whole `admin/data/` directory).

For local dev without AWS, leave `TP_BUCKET` unset — the admin app runs fully, the publish loop becomes a no-op, and the status light shows "AWS not configured (local only)".

## Tests

| File | Covers |
|---|---|
| `admin/src/pairing/round_robin.test.ts` | empty input; even N → N-1 rounds, complete schedule, no duplicates; odd N → N rounds with one bye per round and per player; determinism |
| `admin/src/pairing/swiss.test.ts` | top-with-next pairing; rematch avoidance; bye picks lowest unbyed; fallback when everyone has a bye; throws on impossible board |
| `admin/src/standings.test.ts` | wins-first ordering; tied-on-wins broken by set diff; head-to-head as final tiebreaker; pending matches ignored |

Add new tests when changing pairing or standings logic. Other modules (CRUD routes, UI) are fine without tests.

## Deployment to AWS

### One-time provisioning (per event)

1. **Create the bucket and enable website hosting.**

   ```bash
   REGION=eu-central-1
   BUCKET=tp-result-$(openssl rand -hex 4)

   aws s3 mb s3://$BUCKET --region $REGION
   aws s3api put-public-access-block --bucket $BUCKET \
     --public-access-block-configuration \
     "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false"
   aws s3api put-bucket-policy --bucket $BUCKET \
     --policy file://deploy/s3-bucket-policy.json
   aws s3 website s3://$BUCKET/ \
     --index-document index.html --error-document index.html
   ```

   Result-site URL: `http://$BUCKET.s3-website.$REGION.amazonaws.com`.

2. **Create the IAM publisher user** named `tp-publisher-<bucket>`. Inline policy: `s3:PutObject` + `s3:DeleteObject` + `s3:ListBucket` on this bucket only. Generate an access key.

3. **Upload the static result site:**

   ```bash
   AWS_PROFILE=tp aws s3 sync result-site/ s3://$BUCKET/ \
     --cache-control "public, max-age=3600"
   ```

`deploy/bootstrap-aws.sh` automates steps 1–2 idempotently and prints the access key + env-var block to copy. `deploy/publish-static.sh` wraps step 3.

### Operator workflow — how to push changes to AWS

The mental model: the operator never thinks about "pushing." The admin app does it; the operator watches a status light.

**One-time, before the event:**

```bash
pnpm i                                      # or: npm i
bash deploy/bootstrap-aws.sh                # idempotent; prints bucket name + [tp] creds
# paste [tp] block into ~/.aws/credentials
cp .env.example .env && $EDITOR .env        # fill TP_BUCKET, TP_REGION, AWS_PROFILE=tp
pnpm publish-static                         # uploads HTML/CSS/JS to S3
```

Verify by opening the printed website URL — you should see an empty group-stage page that says "waiting for data…".

**Every working session:**

```bash
pnpm dev                                    # admin app on http://localhost:37325
```

Header status light:
- 🟢 `Synced N seconds ago` — last push succeeded
- 🟡 `N change(s) queued` / `Pushing…` — debounce window or in-flight request
- 🟡 `AWS not configured (local only)` — `TP_BUCKET` not set
- 🔴 `Push failed — <reason> (retrying)` — exponential backoff up to 60 s
- **Force publish** button next to it.

**What happens on each edit:**

```
operator edits a score in the browser
        │
        ▼
PATCH /api/groups/:gid/matches/:mid
        │
        ▼
storage.mutate(): validate → write tmp file → rename → cache
        │
        ▼
Fastify onResponse hook → publish.schedulePublish()
        │  debounce 500 ms (coalesces rapid edits)
        ▼
publish.runPublish():
  load tournament.json
  derive { version.json, groups.json, knockout.json }
  Promise.all PUT to S3 with Cache-Control headers
        │
        ├─ success → status.lastSuccess = now; backoff reset
        └─ failure → status.lastError; retry with backoff (1s → 2s → … → 60s)
```

**When Wi-Fi drops:** edits keep working (local JSON), `pendingChanges` increments, light goes 🟡, backoff doubles up to 60 s. On reconnect, the next debounced push catches up — each push is a full snapshot of the current views, so no per-edit queue is needed.

**Backup pushes (separate path):** every hour the app PUTs a full `tournament.json` snapshot to `s3://$BUCKET/private/backups/tournament-<ts>.json`. The bucket policy denies public read on `private/*`. The Settings tab has a manual **Push backup snapshot** button too.

### Tear-down

```bash
TP_BUCKET=... bash deploy/tear-down.sh      # interactive: empties bucket, deletes IAM user
```

or by hand:

```bash
aws s3 rm s3://$BUCKET --recursive && aws s3 rb s3://$BUCKET
aws iam delete-user-policy --user-name <user> --policy-name tp-publish
aws iam delete-access-key --user-name <user> --access-key-id <id>
aws iam delete-user --user-name <user>
```

## Approximate cost analysis

USD, `eu-central-1` published prices late 2025. Rounded; AWS prices drift.

### Scenario: the event itself (2 days of operation)

Assumes 500 spectators × ~100 hits each, with `version.json`-poll-then-refetch. Browser caching keeps actual S3 GET volume modest.

| Item | Quantity | Unit cost | Cost |
|---|---|---|---|
| S3 storage | <0.1 GB-mo | $0.023/GB-mo | **~$0.01** |
| S3 PUT requests (publishes + backups) | ~5,000 | $5/M | **$0.03** |
| S3 GET requests (poll + view refetches) | ~500,000 worst case | $0.40/M | **$0.20** |
| S3 data transfer out | ~10 GB | first 100 GB/mo free; then $0.09/GB | **$0** (free tier) / **$0.90** |
| **Total (within S3 free tier)** | | | **~$0.25** |
| **Total (no free tier)** | | | **~$1.15** |

No DNS, no certificates, no CloudFront, no domain.

### What pushes the bill up (watch for)

- **S3 versioning** turned on by accident — old versions accumulate. Bootstrap explicitly sets Status=Suspended.
- **Public read on `private/backups/`.** The bucket policy scopes public read to top-level + `assets/` + `data/` only. Test: `curl http://$BUCKET.s3-website.$REGION.amazonaws.com/private/backups/anything` → should be 403.
- **Hot-looping the publish step** (e.g., a bug PUTs hundreds of times/sec). Debounce + retry-with-backoff prevents it.
- **Spectators auto-refreshing aggressively.** Honored `Cache-Control` on `version.json` (5 s) protects this — confirm headers actually landed on PUT.

## Operational checklist (pre-event)

- [ ] Dress rehearsal with ~20 fake participants, all four group modes plus a knockout bracket.
- [ ] Kill Wi-Fi mid-edit — confirm app keeps working and flushes pending PUTs on reconnect.
- [ ] Verify recovery: pull latest backup from S3 to a fresh checkout, confirm app boots with the right data.
- [ ] Backup laptop ready: codebase + `~/.aws/credentials` + Node 20 installed.
- [ ] 4G/5G phone hotspot tested at the venue.
- [ ] Result-site URL renders correctly on a phone — most spectators will view on mobile. Browsers will show "not secure" — confirm the director is OK with that.
- [ ] QR code for the result-site URL printed and ready to display at the venue.
- [ ] `Cache-Control` headers verified on each published object (`curl -I`).
- [ ] IAM key has only `s3:PutObject`/`s3:DeleteObject`/`s3:ListBucket` on this one bucket.
- [ ] Recovery procedure printed on paper.
- [ ] `private/backups/` prefix verified non-public (`curl` returns 403).

## What this project explicitly is NOT

- Not a registration/payment system. Participants come from CSV.
- Not a multi-tournament platform. One tournament, one JSON file. Clone the repo for a second event.
- Not multi-operator. One scorekeeper at one laptop is the entire write path. If a future event needs multiple concurrent editors, the architecture changes (back to a hosted server).
- Not real-time in the sub-second sense. Result-site pages update within ~30 s of an admin save. Fine for badminton.
- Not mobile-app native. Responsive web is enough.

## Notes for future Claude sessions

- The "single operator" assumption is load-bearing. If the user starts asking for multi-admin or multi-device write workflows, flag the architecture-level change before coding anything.
- The local app's source of truth is `admin/data/tournament.json`. Always go through `storage.mutate()` — it validates with zod, serializes writes, and does atomic temp+rename. Never write the file in place.
- Standings + tiebreaker logic lives in `admin/src/standings.ts` and runs at publish time. Do not reimplement it in the result-site JS. The result site just renders what `groups.json` contains.
- Pairing algorithms get unit tests with deterministic seeds. Everything else is fine without tests.
- Publishing to S3 is debounced and retry-queued via the Fastify `onResponse` hook — don't push synchronously inside HTTP handlers.
- The bucket policy intentionally lists exact public-readable paths. If you add a new public-facing file at a new prefix, update `deploy/s3-bucket-policy.json` and re-apply, or the file will 403.
- The admin app mounts `result-site/` at `/view/` purely as a dev preview. It is **not** a production serving path — spectators always hit the S3 website URL, not the operator's laptop. Don't add auth, rate-limiting, or anything that assumes external traffic to `/view/`; if a feature would only make sense for real spectators, it belongs in the publish pipeline, not the route.
- Group membership is exclusive: a participant assigned to one group is hidden from every other group's add-member checklist. If a future workflow needs a player to compete in two groups (e.g. mixed + singles draws on the same weekend), this rule has to be relaxed — flag it before changing the filter.
- `Participant.category`, `Participant.class`, and `Group.category` are open strings in the schema; the canonical sets (`MS/WS/MD/WD/MX` and `S/A/B/C/D`) are enforced only by the form selects so new disciplines or skill bands can be added without a schema migration. If you tighten them to enums, write a migration for any existing rows first.
- Don't introduce an ORM, a database, a message queue, a hosted backend, or Cognito without a concrete reason tied to *this event*. If you're tempted, re-read "Hard constraints".
