---
name: dev
description: Build, run, smoke-test, and develop the tournament-planner Fastify admin app + S3-bound result site. Use when asked to start the admin, run vitest, drive the API, or exercise pairing/standings/publish. Playwright (Chromium) is installed locally — visual/screenshot checks of the admin UI and result viewer are in scope; see "Screenshot UI" below.
allowed-tools: Bash(curl:*), Bash(ping:*), Bash(node:*), Bash(lsof:*)
---

A local Node + Fastify admin app on `http://localhost:37325` that owns
`admin/data/tournament.json` (zod-validated source of truth) and derives the
result JSONs the S3-website-hosted result site fetches on page load. One repo,
no build step, no hosted backend. The runnable project lives in **`app/`** —
`cd app` first; all paths and commands below are relative to that directory.

Drive it via the `tests/` harness. `node tests/run-all.mjs` walks the full
lifecycle (rename → participants → group → next-round → score → knockout →
`/view/data/*.json` → pending log/undo, plus a Playwright UI check) across 7
isolated `*.test.mjs` scripts. Per-script coverage table: `tests/README.md`.

### Isolation pattern (shared by every harness entry point)

`run-all.mjs`, `serve.mjs`, and `scripts/screenshot-views.mjs` all boot the
**real** server the same way, so they never collide with a `pnpm dev` the
operator may already have on 37325 and never touch AWS:

- random free port via `net.createServer().listen(0)`
- `tsx admin/src/index.ts` with a temp `TP_DATA_FILE=/tmp/tp-test-XXX/...`
- `TP_BUCKET=''` → publish loop is a no-op (just bumps `pendingChanges`)
- poll `/api/state` until 200 (30 s deadline), then seed + assert
- on exit: SIGKILL the process group **plus** an `lsof -sTCP:LISTEN` backstop
  on the port (the `tsx → node` grandchild escapes the pgroup — see Gotchas),
  then `rm -rf` the temp dir

Shared boot/seed/cleanup lives in `tests/lib/harness.mjs`. Reuse it for any new 
launcher rather than re-deriving this.

## Prerequisites

System Node 18+ runs everything (vitest, tsx, the admin app):

```bash
node --version   # v18.x or newer
```

Node 20 is recommended in production only because the AWS SDK warns on 18; 18 is
fine for all dev/test on this container. No `apt-get` packages needed — pure
JS/TS. `lsof` (used by the harness for cleanup) is preinstalled on Ubuntu.

**Headless browser:** Playwright (a devDependency) backs the screenshot script
and the `jump-to-matches` UI test. If `chromium.launch()` throws about a missing
`.so`, run `sudo npx playwright install-deps chromium` once.

**Dependencies:** `npm install` (or `pnpm install`). No build step — the app
runs straight from source via `tsx`. AWS env vars matter only for a real publish
(see Gotchas); `admin/data/tournament.json` is seeded on first run, wipe with
`rm -rf admin/data/`.

## Run (agent path)

### Smoke the whole stack

```bash
node tests/run-all.mjs          # all 7 tests/*.test.mjs, serially, aggregated
node tests/pairing.test.mjs     # or one slice on its own
```

Each script uses the Isolation pattern above and asserts on one feature area
(`participants`, `pairing`, `scoring`, `knockout`, `views`, `pending`,
`jump-to-matches`). `run-all.mjs` exits nonzero if any fail. Expected tail:

```
✓ all 7 test scripts passed
```

A single script exits 0 on success, 1 with `✗ <name> failed: …` on assertion
fail. Add `TP_TEST_VERBOSE=1` to echo the Fastify per-request logs when you need
to see which response went wrong.

### Long-running server for poking by hand or with curl

```bash
node tests/serve.mjs --port 38400
# admin   → http://localhost:38400/
# viewer  → http://localhost:38400/view/
# Ctrl-C to stop and clean the temp data dir.
```

Same isolation. Use when you want to `curl /api/...`, inspect `/view/data/*.json`
or `/api/state`, or hand the URL to the operator for their own browser. For
visual checks, use the screenshot script below.

### Screenshot UI

```bash
node scripts/screenshot-views.mjs            # writes debug/screenshots/{index,knockout}.png
node scripts/screenshot-views.mjs --keep     # leave the server running on its random port
```

Same isolation but a heavier seed: 5 categories × 1–2 classes, five groups
(round-robin / swiss / manual mix), and 4-/8-/32-slot knockouts so the 5-column
overview tree, the inline ≤4-round bracket, and the 5-round 2+3 row split all
render at once. Chromium drives `/view/index.html` and `/view/knockout.html` at
1400×2000, full-page PNGs to `debug/screenshots/`. Run it after changing
`result-site/assets/render-*.js` or `app.css` — the PNG diff catches what an
HTTP-only smoke can't. Kept separate from the API smokes so those stay fast
(no browser); the screenshot run is ~10 s on a cold Chromium launch.

### Direct API call without the harness

Lowest-overhead way to hit one route (the server reads env vars at boot):

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

Admin UI at the root, `/view/` for the result viewer on live data. The
operator's normal workflow. Useless headless — all the value is the
click-through UI, which is why the agent path uses the `tests/` harness.

## Test

The check gate is colocated unit tests, then the e2e harness:

```bash
npx vitest run        # unit: 4 files / 17 tests (round_robin + swiss + dispatch + standings)
node tests/run-all.mjs   # e2e: see "Smoke the whole stack" above
```

`vitest` covers the pure logic — pairing algorithms (circle method, no-rematch
Swiss, bye rotation), strategy dispatch, and the standings tiebreaker authority
(wins → set diff → point diff → h2h). These live colocated as
`admin/src/**/*.test.ts` (discovered by `vitest.config.ts`); run before changing
anything under `admin/src/pairing/` or `admin/src/standings.ts`. Run
`run-all.mjs` before changing anything under `admin/src/routes/` or
`admin/src/publish.ts`.

## Tech stack

- **Admin server:** Fastify 4, zod (schema + validation), `@fastify/static`,
  `@aws-sdk/client-s3`, `nanoid` (IDs), `csv-parse` (participant import).
- **Persistence:** one `tournament.json`. `storage.ts` keeps an in-memory cache,
  serializes writes through a `writeChain`, commits via temp-file + `rename`
  (atomic). No DB, no ORM.
- **UI (admin + result):** plain HTML + vanilla JS ES modules + one CSS file. No
  framework, no bundler. The result site is uploaded to S3 as-is.
- **TS execution:** `tsx` runs `.ts` directly. `tsconfig.json` is `noEmit` (IDE
  typing only) — there is no compile step in any workflow.

## Architecture (TL;DR for development)

```
admin/src/index.ts            Fastify boot. onResponse hook → schedulePublish on 2xx mutations.
                              Serves admin UI at /, mounts result-site at /view/, exposes the
                              dynamic /view/data/:file route that derives JSONs on the fly.
admin/src/storage.ts          load/mutate/save. ALL writes go through mutate(): zod validate
                              → temp file → rename → in-memory cache. Never write in place.
                              TP_DATA_FILE env var overrides the default path.
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
                              publish policy) + publish-static.sh + pack-portable.sh. Real S3
                              provisioning only; not exercised by the tests/ harness.
scripts/                      one-off TS helpers + screenshot tools. Run via
                              node_modules/.bin/tsx scripts/<name>.ts (or node for the .mjs ones).
tests/                        end-to-end *.test.mjs harness (run-all.mjs aggregates; serve.mjs
                              for manual poking) + shared lib/harness.mjs.
```

Dev guardrails — break these and the code corrupts data or diverges:

- **All writes go through `storage.mutate()`** (serialized, atomic temp+rename).
  Bypassing it corrupts the file on a crash.
- **Pairing/standings logic lives in `admin/src/`**, never duplicated in
  `result-site/` — that JS only renders pre-computed views.
- **The `onResponse` hook bumps `pendingChanges`** for 2xx `/api/*` mutations
  (excluding `/api/publish/*`); the S3 push is operator-triggered, never
  synchronous in a handler.

For the design constraints these follow from (single writer/laptop, exclusive
group membership, open-string `category`/`class`, no DB/backend), see CLAUDE.md.

## Further reading

Operational essentials are above; reach for these for deeper questions:

- **`docs/API-endpoints.md`** — every HTTP route with its body shape. Read
  before adding a `tests/*.test.mjs` slice or curling a route the smoke flow
  doesn't cover.
- **`docs/Architecture.md`** — full S3 layout, per-object `Cache-Control`
  budget, and the "why this shape" rationale.
- **`docs/Dev-deploy-test.md`** — the AWS bring-up flow
  (`deploy/cloudformation.yaml` via `make cfn-deploy`, then
  `deploy/publish-static.sh`). Read before touching `deploy/`.
- **`CLAUDE.md`** — full architectural rationale.

## Gotchas

- **`tsx` forks a node grandchild that escapes the spawn's process group.**
  `process.kill(-pid, 'SIGKILL')` doesn't reach it — `tests/lib/harness.mjs`
  adds an `lsof -sTCP:LISTEN -t` backstop on its random port. Same for any
  launcher you write.
- **`lsof -ti tcp:PORT` includes client sockets** — i.e. your harness's own
  `fetch()` calls. Always add `-sTCP:LISTEN` or you'll kill yourself (the
  harness hit this once and printed `Killed`).
- **Don't hardcode 37325** — the operator's `pnpm dev` may hold it, so the
  harness picks a random port. To check if their instance is up:
  `curl -sf http://localhost:37325/api/state`.
- **`PUT /api/state/name` wants `{ name }`,** not `{ tournament: { name } }`.
- **`schedulePublish()` runs even with `TP_BUCKET=''`** — it only increments
  `pendingChanges`; there's no automatic PUT. A `pendingChanges: 10` in smoke
  output reflects this, not a bug.
- **Adding a public file at a new S3 prefix** means updating the
  `ResultBucketPolicy` in `deploy/cloudformation.yaml` and redeploying — the
  policy whitelists exact paths, so a new prefix 403s without an explicit allow.

## Troubleshooting

- **`assertion failed: expected 4 participants, got 8`** — a stale server is
  bound to the port and the harness is hitting it. Fix:
  `pkill -9 -f 'admin/src/index.ts'` (filter `grep -v watch` to preserve the
  operator's `tsx watch`), then re-run.
- **`server never came up` within 30 s** — usually a `tsx` startup error on
  stderr (forwarded verbatim as `[srv!]`). Re-run with `TP_TEST_VERBOSE=1`.
- **`EADDRINUSE` from a test script** — should be impossible (random port); if
  it happens, `lsof -i :<PORT>` to find the stale orphan, `kill -KILL` it.
- **Leftover `/tmp/tp-test-*` dirs** after a hard kill — `rm -rf /tmp/tp-test-*`
  to sweep. Safe; each is single-use.
