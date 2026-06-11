---
name: run-tournament-planner
description: Build, run, smoke-test, and develop the tournament-planner Fastify admin app + S3-bound result site. Use when asked to start the admin, run vitest, drive the API, exercise pairing/standings/publish, or screenshot the result viewer.
---

A local Node + Fastify admin app on `http://localhost:37325` that owns
`admin/data/tournament.json` (zod-validated source of truth) and derives result
JSONs the result site (S3-website-hosted) polls. Everything in one repo, no
build step, no hosted backend.

Drive it via `.claude/skills/run-tournament-planner/driver.mjs` — that script
boots the real server on a random free port against a temp `TP_DATA_FILE`,
walks the full lifecycle (rename → participants → group → next-round → score
match → knockout → fetch `/view/data/*.json`), and asserts on responses. All
paths below are relative to the repo root.

## Prerequisites

System Node 18+ runs everything (vitest, tsx, the admin app). CLAUDE.md
recommends Node 20 in production because the AWS SDK warns on 18; for
development on this container, 18 is fine.

```bash
node --version   # v18.x or newer
```

No `apt-get` packages were needed — the project is pure JS/TS. `lsof` is used
by `driver.mjs` for cleanup and is preinstalled on Ubuntu.

## Setup

```bash
npm install        # or: pnpm install
```

That's it. No build step. There is no `.env` required for local development —
if `TP_BUCKET` is unset, the admin app logs `running in local-only mode (no S3
push)` and the publish loop becomes a no-op. AWS env vars are needed only when
actually publishing to S3 (see Architecture below).

The data file at `admin/data/tournament.json` is created from a seed on first
run. To wipe it: `rm -rf admin/data/`.

## Run (agent path)

### Smoke the whole stack

```bash
node .claude/skills/run-tournament-planner/driver.mjs
```

What it does — fully isolated, ~3 s, no AWS, no port collision with a `pnpm
dev` the operator may already have running:

1. Picks a random free port via `net.createServer().listen(0)`.
2. Spawns `node_modules/.bin/tsx admin/src/index.ts` with `PORT=<random>`,
   `TP_DATA_FILE=/tmp/tp-driver-XXX/tournament.json`, `TP_BUCKET=''`.
3. Polls `/api/state` until 200 (30 s deadline).
4. Exercises the API end-to-end: rename → 4 participants → round-robin group
   → `next-round` (asserts circle method → 2 matches) → mark a match
   live→done (asserts `startedAt`/`finishedAt` stamping) → create a 4-slot
   knockout → GET `/view/data/{version,groups,knockout}.json` (asserts
   pre-computed standings) → check `/api/publish/status`.
5. SIGKILLs the process group plus an `lsof -sTCP:LISTEN` backstop on the
   random port (the `tsx → node` grandchild escapes the spawn's pgroup —
   see Gotchas). `rm -rf` the temp dir.

Expected tail:

```
✓ all smoke checks passed
```

Exits 0 on success, 1 on any assertion fail with `✗ driver failed: …`.

### Long-running server for poking by hand or with curl

```bash
node .claude/skills/run-tournament-planner/driver.mjs serve --port 38400
# admin   → http://localhost:38400/
# viewer  → http://localhost:38400/view/
# Ctrl-C to stop and clean the temp data dir.
```

Same isolation (temp data file, no S3). Use this when you want to `curl
/api/...`, point a browser at the admin UI, or run `chromium-cli` against
`/view/`.

### Verbose mode

`TP_DRIVER_VERBOSE=1 node .claude/skills/run-tournament-planner/driver.mjs`
echoes the Fastify per-request logs (helpful when an assertion fails and you
need to see which response went wrong).

### Direct API call without the harness

The server reads env vars at boot, so this is the lowest-overhead way to test
one route:

```bash
PORT=39000 TP_BUCKET= node_modules/.bin/tsx admin/src/index.ts &> /tmp/tp.log &
until curl -sf http://localhost:39000/api/state >/dev/null; do sleep 0.2; done
curl -s http://localhost:39000/api/state | head -c 200
# … hack …
lsof -t -iTCP:39000 -sTCP:LISTEN | xargs -r kill -KILL
```

## Run (human path)

```bash
npm run dev      # tsx watch admin/src/index.ts → http://localhost:37325
```

Default port 37325. Open the URL for the admin UI; `/view/` for the result
viewer wired to the live data. The operator's normal workflow. Useless
headless because all the value is the click-through UI — that's why the
agent path uses `driver.mjs`.

## Test

```bash
npx vitest run
# expect: 3 files / 13 tests passed (round_robin + swiss + standings).
```

These are pure unit tests covering pairing algorithms (circle method,
no-rematch Swiss, bye rotation) and the standings tiebreaker authority
(wins → set diff → point diff → h2h). Run them before changing any file
under `admin/src/pairing/` or `admin/src/standings.ts`.

## Tech stack

- **Runtime:** Node 20 LTS in production (the AWS SDK warns on 18). Node 18 is
  fine for tests and the driver harness on this container.
- **Admin server:** Fastify 4, zod (schema + validation), `@fastify/static`,
  `@aws-sdk/client-s3`, `nanoid` (IDs), `csv-parse` (participant import).
- **Persistence:** one `tournament.json`. `storage.ts` keeps an in-memory cache,
  serializes writes through a `writeChain` promise, and commits via temp-file +
  `rename` (atomic). No DB, no ORM.
- **UI (admin + result):** plain HTML + vanilla JS ES modules + a single CSS
  file. No framework, no bundler. Same shape for both surfaces — the result
  site is uploaded to S3 as-is.
- **TS execution:** `tsx` runs `.ts` directly. `tsconfig.json` is `noEmit` —
  it exists only for IDE typing, there is no compile step in any workflow
  (dev, tests, driver, or deploy).
- **Tests:** Vitest, 13 tests across `round_robin` / `swiss` / `standings`.
  All passing on `main`.

## Architecture (TL;DR for development)

```
admin/src/index.ts            Fastify boot. onResponse hook → schedulePublish on 2xx mutations.
                              Serves admin UI at /, mounts result-site at /view/, exposes the
                              dynamic /view/data/:file route that derives JSONs on the fly.
admin/src/storage.ts          load/mutate/save. ALL writes go through mutate(): zod validate
                              → temp file → rename → in-memory cache. Never write the file
                              in place. TP_DATA_FILE env var overrides the default path.
admin/src/schema.ts           zod schemas for the entire JSON shape.
admin/src/standings.ts        tiebreaker authority. Runs at publish time. Do NOT reimplement
                              in result-site JS — that JS just renders what groups.json contains.
admin/src/publish.ts          deriveViews() + manual S3 PUT (Force publish) + backup snapshot.
                              schedulePublish() only bumps pendingChanges; the push is operator-
                              triggered, not debounced/automatic.
admin/src/pairing/            { round_robin | swiss | manual } strategy dispatch (+ tests).
admin/src/routes/             one file per resource: state, participants, groups, matches,
                              knockout, publish.
admin/public/                 admin UI (plain HTML + vanilla JS, no build). index.html + assets/.
admin/data/tournament.json    single source of truth (gitignored). Created on first run.
result-site/                  static files for S3 (index.html + knockout.html + assets/ + data/).
                              Mounted by Fastify at /view/ for local preview with live data.
deploy/                       bootstrap-aws.sh + publish-static.sh + tear-down.sh +
                              iam-policy.json + s3-bucket-policy.json. Only used for real S3
                              provisioning; not exercised by driver.mjs.
scripts/                      one-off TS helpers (import-ettlingen, migrate-split-category).
                              Run with `node_modules/.bin/tsx scripts/<name>.ts`.
```

Key invariants — break these and the project's design breaks:

- **Single writer.** The admin app on one laptop is the only thing mutating
  `tournament.json`. No multi-admin support, no concurrent editing.
- **Pairing/standings logic lives in `admin/src/`** — never duplicated in
  `result-site/`. The result site renders pre-computed views.
- **State changes flow through `storage.mutate()`**, which serializes writes
  and does atomic temp+rename. Bypassing it corrupts the file on a crash.
- **The Fastify `onResponse` hook bumps `pendingChanges`** for 2xx mutations on
  `/api/*` (excluding `/api/publish/*`). The actual S3 push is operator-
  triggered via the "Force publish" button — don't push synchronously inside an
  HTTP handler.
- **Group membership is exclusive.** A participant belongs to at most one group
  at a time; the member-picker UI hides anyone already in another group. Flag
  before relaxing this — it underpins how standings and pairings are scoped.
- **`category` and `class` are open strings**, constrained only by the form
  selects in the admin UI. The schema accepts arbitrary strings so the operator
  can introduce ad-hoc values. Write a migration before tightening either to
  a zod enum.
- **No ORM, database, message queue, hosted backend, or Cognito.** The whole
  design assumes one operator, one laptop, one JSON file, and S3 for read-only
  fan-out. See CLAUDE.md "Hard constraints" before reaching for any of those.

For the full architectural rationale see `CLAUDE.md` at the repo root.

## Gotchas

- **`tsx` forks a node grandchild that escapes the spawn's process group.**
  `process.kill(-pid, 'SIGKILL')` doesn't reach it. `driver.mjs` works around
  this with an `lsof -sTCP:LISTEN -t` backstop on its random port. If you
  write your own launcher, expect to do the same.
- **`lsof -ti tcp:PORT` includes client sockets** — i.e. your own driver's
  `fetch()` calls. Always add `-sTCP:LISTEN` or you'll kill yourself. The
  driver hit this on an early iteration and printed `Killed`.
- **`pnpm dev` on port 37325 may already be running** when the agent starts.
  `driver.mjs` therefore picks a random free port; don't hardcode 37325. If
  you need to know whether the operator's instance is up, `curl -sf
  http://localhost:37325/api/state`.
- **`PUT /api/state/name` requires `{ name }`,** not `{ tournament: { name }
  }`. The route validates with `body.name` directly.
- **`schedulePublish()` runs even with `TP_BUCKET=''`** — it just increments
  `pendingChanges`; there is no automatic PUT. The publish-status object in the
  smoke output (`pendingChanges: 10`) reflects this, not a bug.
- **Adding a new public file at a new S3 prefix** means updating
  `deploy/s3-bucket-policy.json` — the policy whitelists exact paths, so a
  new prefix 403s without an explicit allow.

## Troubleshooting

- **`assertion failed: expected 4 participants, got 8`** — a previous server
  is still bound to the port and the driver is hitting it instead of its own
  spawn. Happened during development when an earlier driver process crashed
  without cleanup. Fix: `pkill -9 -f 'admin/src/index.ts'` (preserve the
  operator's `tsx watch` by filtering with `grep -v watch`), then re-run.
- **`server never came up`** within 30 s — usually a `tsx` startup error
  showing on stderr (the driver forwards stderr verbatim with `[srv!]`).
  Re-run with `TP_DRIVER_VERBOSE=1` to see all server logs.
- **`EADDRINUSE` from the driver** — should be impossible (random port), but
  if it happens: stale orphan binding the chosen port. `lsof -i :<PORT>` to
  identify, `kill -KILL` it.
- **Leftover `/tmp/tp-driver-*` dirs** after a hard kill of the driver —
  `rm -rf /tmp/tp-driver-*` to sweep. Safe; each is single-use.
