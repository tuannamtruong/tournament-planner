---
name: dev
description: Build, run, smoke-test, and develop the tournament-planner Fastify admin app + S3-bound result site. Use when asked to start the admin, run vitest, drive the API, or exercise pairing/standings/publish. Playwright (Chromium) is installed locally — visual/screenshot checks of the admin UI and result viewer are in scope; see "Screenshot UI" below.
allowed-tools: Bash(curl:*), Bash(ping:*), Bash(node:*), Bash(lsof:*)
---

A local Node + Fastify admin app on `http://localhost:37325` that owns
`admin/data/tournament.json` (zod-validated source of truth) and derives result
JSONs the result site (S3-website-hosted) fetches on page load. Everything in one repo, no
build step, no hosted backend.

Drive it via the `tests/` harness scripts. `node tests/run-all.mjs` runs the
whole suite — each `*.test.mjs` boots the real server on a random free port
against a temp `TP_DATA_FILE`, seeds just what it needs, and asserts on
responses, walking the full lifecycle (rename → participants → group →
next-round → score match → knockout → `/view/data/*.json` → pending log/undo,
plus a Playwright UI check). All paths below are relative to the repo root.

## Prerequisites

System Node 18+ runs everything (vitest, tsx, the admin app). CLAUDE.md
recommends Node 20 in production because the AWS SDK warns on 18; for
development on this container, 18 is fine.

```bash
node --version   # v18.x or newer
```

No `apt-get` packages were needed — the project is pure JS/TS. `lsof` is used
by the test harness (`tests/lib/harness.mjs`) for cleanup and is preinstalled
on Ubuntu.

**Headless browser:** Playwright is a devDependency and its Chromium binary
lives under `~/.cache/ms-playwright/`. The result viewer is screenshotted via
`scripts/screenshot-views.mjs` (see "Screenshot UI" below) and the admin UI is
exercised by `tests/jump-to-matches.test.mjs`. The screenshot script boots an
isolated server on a random port,
seeds enough data to exercise the renderer, screenshots `/view/index.html` and
`/view/knockout.html`, and writes PNGs to `debug/screenshots/`. Fastest way to
catch a regression in the group-stage tree or the knockout bracket layout
without an operator in the loop.

Limit: Playwright's Chromium needs a few apt libs that come from Ubuntu's
defaults; if `chromium.launch()` throws about a missing `.so`, run
`sudo npx playwright install-deps chromium` once. The harness does NOT do this
itself — it'd prompt for sudo and break the no-interaction agent path.

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
node tests/run-all.mjs          # every tests/*.test.mjs, aggregated
node tests/pairing.test.mjs     # or one slice on its own
```

`run-all.mjs` runs each `*.test.mjs` in its own process, serially, and exits
nonzero if any fail. Each script — fully isolated, no AWS, no port collision
with a `pnpm dev` the operator may already have running — does:

1. Picks a random free port via `net.createServer().listen(0)`.
2. Spawns `node_modules/.bin/tsx admin/src/index.ts` with `PORT=<random>`,
   `TP_DATA_FILE=/tmp/tp-test-XXX/tournament.json`, `TP_BUCKET=''`.
3. Polls `/api/state` until 200 (30 s deadline).
4. Seeds just its prerequisites and asserts on one feature area. Across the
   suite: rename + participants (`participants`), round-robin group +
   `next-round`/circle method (`pairing`), live→done scoring + timestamp
   stamping (`scoring`), bracket create + odd-N byes (`knockout`),
   `/view/data/{version,groups,knockout}.json` + pre-computed standings +
   publish status (`views`), pending-log summaries + linear/all revert
   (`pending`), and a Playwright tab-jump UI check (`jump-to-matches`).
5. SIGKILLs the process group plus an `lsof -sTCP:LISTEN` backstop on the
   random port (the `tsx → node` grandchild escapes the spawn's pgroup —
   see Gotchas). `rm -rf` the temp dir.

Expected tail:

```
✓ all 7 test scripts passed
```

Each script exits 0 on success, 1 on any assertion fail with `✗ <name> failed: …`.

The shared boot/seed/cleanup lives in `tests/lib/harness.mjs`; see
`tests/README.md` for the per-script table.

### Long-running server for poking by hand or with curl

```bash
node tests/serve.mjs --port 38400
# admin   → http://localhost:38400/
# viewer  → http://localhost:38400/view/
# Ctrl-C to stop and clean the temp data dir.
```

Same isolation (temp data file, no S3). Use this when you want to `curl
/api/...` or hand the URL to the operator so they can poke the admin UI in
their own browser. For visual checks see "Screenshot UI" below; for
JSON-only inspection from here, hit `/view/data/*.json` and `/api/state`.

### Screenshot UI

```bash
node scripts/screenshot-views.mjs            # writes debug/screenshots/*.png
node scripts/screenshot-views.mjs --keep     # leave the server running on a random port
```

What it does — same isolation pattern as the test harness (random free port,
temp `TP_DATA_FILE`, `TP_BUCKET=''`), but with a heavier seed: 5 categories x 1–2
classes of participants, five groups (round-robin / swiss / manual mix), and
three knockouts (4-, 8-, and 32-slot) so the 5-column overview tree, the
inline ≤4-round bracket layout, and the 5-round 2+3 row split all render in
one shot. Playwright's Chromium drives `/view/index.html` and
`/view/knockout.html` at 1400×2000, full-page PNGs written to
`debug/screenshots/index.png` and `knockout.png`. Use it whenever you
change `result-site/assets/render-*.js` or `app.css` — the diff against the
previous PNG catches regressions an HTTP-only smoke can't.

The script is intentionally separate from the API smokes: those stay fast
(no browser) for API correctness checks, and the screenshot script (~10 s on a
cold Chromium launch) only runs when you need eyes on the rendered HTML.

### Verbose mode

`TP_TEST_VERBOSE=1 node tests/run-all.mjs` (or any single `*.test.mjs`)
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
agent path uses the `tests/` harness.

## Test

The full check gate is two commands — colocated unit tests, then the
end-to-end harness:

```bash
npx vitest run        # unit: 3 files / 13 tests (round_robin + swiss + standings)
node tests/run-all.mjs   # e2e: 7 *.test.mjs scripts against a real server
```

`vitest` covers the pure logic — pairing algorithms (circle method, no-rematch
Swiss, bye rotation) and the standings tiebreaker authority (wins → set diff →
point diff → h2h). These live colocated as `admin/src/**/*.test.ts` and are
discovered by `vitest.config.ts`; run them before changing any file under
`admin/src/pairing/` or `admin/src/standings.ts`.

`tests/run-all.mjs` covers the HTTP API + view derivation + a Playwright UI
check end-to-end against a real Fastify boot (see "Smoke the whole stack" and
`tests/README.md`). Run it before changing anything under `admin/src/routes/`
or `admin/src/publish.ts`.

## Tech stack

- **Runtime:** Node 20 LTS in production (the AWS SDK warns on 18). Node 18 is
  fine for tests and the `tests/` harness on this container.
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
  (dev, tests, harness, or deploy).
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
admin/src/publish.ts          deriveViews() + manual S3 PUT (Publish) + backup snapshot.
                              schedulePublish() only bumps pendingChanges; the push is operator-
                              triggered, not debounced/automatic.
admin/src/pairing/            { round_robin | swiss | manual } strategy dispatch (+ tests).
admin/src/routes/             one file per resource: state, participants, groups, matches,
                              knockout, publish.
admin/public/                 admin UI (plain HTML + vanilla JS, no build). index.html + assets/.
admin/data/tournament.json    single source of truth (gitignored). Created on first run.
result-site/                  static files for S3 (index.html + knockout.html + assets/ + data/).
                              Mounted by Fastify at /view/ for local preview with live data.
deploy/                       cloudformation.yaml (bucket + tp-publisher IAM user + inline
                              publish policy) + publish-static.sh (sync result-site/ to S3) +
                              pack-portable.sh (Windows bundle). Only used for real S3
                              provisioning; not exercised by the tests/ harness.
scripts/                      one-off TS helpers (import-ettlingen, migrate-split-category) +
                              screenshot tools. Run with `node_modules/.bin/tsx scripts/<name>.ts`.
tests/                        end-to-end *.test.mjs harness scripts (run-all.mjs aggregates;
                              serve.mjs for manual poking) + shared lib/harness.mjs. Unit tests
                              stay colocated as admin/src/**/*.test.ts.
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
  triggered via the "Publish" button — don't push synchronously inside an
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

## Further reading

The skill keeps the operational essentials. Reach for these when the question
goes beyond running the app:

- **`docs/API-endpoints.md`** — every HTTP route with its body shape. Read
  before adding a `tests/*.test.mjs` slice or curling a route the smoke flow
  doesn't cover.
- **`docs/Architecture.md`** — full S3 layout diagram, per-object
  `Cache-Control` budget, and the "why this shape" rationale (single operator
  + S3-only + offline-tolerant).
- **`docs/Dev-deploy-test.md`** — the human `pnpm dev` / `/view/` preview
  loop (the skill already covers this) plus the AWS bring-up flow
  (`deploy/cloudformation.yaml` via `make cfn-deploy`, then
  `deploy/publish-static.sh`). Read before touching anything under `deploy/`.

## Gotchas

- **`tsx` forks a node grandchild that escapes the spawn's process group.**
  `process.kill(-pid, 'SIGKILL')` doesn't reach it. `tests/lib/harness.mjs`
  works around this with an `lsof -sTCP:LISTEN -t` backstop on its random port.
  If you write your own launcher, expect to do the same.
- **`lsof -ti tcp:PORT` includes client sockets** — i.e. your own harness's
  `fetch()` calls. Always add `-sTCP:LISTEN` or you'll kill yourself. The
  harness hit this on an early iteration and printed `Killed`.
- **`pnpm dev` on port 37325 may already be running** when the agent starts.
  The harness therefore picks a random free port; don't hardcode 37325. If
  you need to know whether the operator's instance is up, `curl -sf
  http://localhost:37325/api/state`.
- **`PUT /api/state/name` requires `{ name }`,** not `{ tournament: { name }
  }`. The route validates with `body.name` directly.
- **`schedulePublish()` runs even with `TP_BUCKET=''`** — it just increments
  `pendingChanges`; there is no automatic PUT. The publish-status object in the
  smoke output (`pendingChanges: 10`) reflects this, not a bug.
- **Adding a new public file at a new S3 prefix** means updating the
  `ResultBucketPolicy` block in `deploy/cloudformation.yaml` and redeploying
  the stack — the policy whitelists exact paths, so a new prefix 403s without
  an explicit allow.

## Troubleshooting

- **`assertion failed: expected 4 participants, got 8`** — a previous server
  is still bound to the port and the harness is hitting it instead of its own
  spawn. Happened during development when an earlier harness process crashed
  without cleanup. Fix: `pkill -9 -f 'admin/src/index.ts'` (preserve the
  operator's `tsx watch` by filtering with `grep -v watch`), then re-run.
- **`server never came up`** within 30 s — usually a `tsx` startup error
  showing on stderr (the harness forwards stderr verbatim with `[srv!]`).
  Re-run with `TP_TEST_VERBOSE=1` to see all server logs.
- **`EADDRINUSE` from a test script** — should be impossible (random port), but
  if it happens: stale orphan binding the chosen port. `lsof -i :<PORT>` to
  identify, `kill -KILL` it.
- **Leftover `/tmp/tp-test-*` dirs** after a hard kill of a test script —
  `rm -rf /tmp/tp-test-*` to sweep. Safe; each is single-use.
