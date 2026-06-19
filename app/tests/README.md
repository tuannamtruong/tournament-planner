# tests/

End-to-end / browser-driven checks that are too heavy or too app-level for the
Vitest unit suite (which stays colocated next to source as `admin/src/**/*.test.ts`).

Each `*.test.mjs` script is self-contained: it boots the **real** admin server
on a random free port against a temp `TP_DATA_FILE` (no S3, no collision with a
running `npm run dev`), seeds just the data it needs over the HTTP API, asserts,
and cleans up. Exit 0 = pass, 1 = fail. The shared boot/seed/cleanup lives in
[`lib/harness.mjs`](lib/harness.mjs).

Run from the **`app/` directory** (the project root) so `tsx` and Playwright resolve from `node_modules`.

```bash
node tests/run-all.mjs            # run every *.test.mjs, aggregate, exit 0/1
node tests/participants.test.mjs  # or run one slice
```

| Script | Checks |
| --- | --- |
| `participants.test.mjs` | Rename tournament; add participants. |
| `pairing.test.mjs` | Round-robin group create → next-round (circle method → 2 matches). |
| `scoring.test.mjs` | Match live→done with set scores; `startedAt`/`finishedAt` stamping. |
| `knockout.test.mjs` | Bracket create; odd-N rounds up to a power of two with byes. |
| `views.test.mjs` | `/view/data/{version,groups,knockout}.json` shape + pre-computed standings; publish status. |
| `pending.test.mjs` | Pending-log tab+summary rendering; linear undo / revert-all. |
| `jump-to-matches.test.mjs` | (Playwright) clicking a group's standings jumps to the Matches tab and flashes its card. |

`run-all.mjs` runs each script in its own process, serially, and exits nonzero
if any fail.

## Not a test

```bash
node tests/serve.mjs --port 38400   # long-running isolated server for manual poking
```

Same isolation as the test scripts, but it just stays up (admin at `/`, viewer
at `/view/`). Ctrl-C cleans the temp dir.

`TP_TEST_VERBOSE=1` forwards the Fastify per-request logs (off by default so the
output is just the ✓ checks).
