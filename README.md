# Tournament Planner

A small web app for running a badminton-style tournament.

Two surfaces in two places:

- **Admin** — Fastify app running on the tournament director's laptop at `http://localhost:37325`. Owns the canonical data (a JSON file), imports participants, builds groups, runs pairings, enters scores, manages the knockout.
- **Result site** — read-only static `index.html` + `knockout.html` hosted on S3 with website hosting enabled. Polls `data/version.json` every 15 s and refetches view JSONs when it changes.

There is no backend in AWS. The admin app derives view JSONs and PUTs them to S3 when the operator clicks **Publish**.

## Docs

| File | What's in it |
|---|---|
| [docs/Architecture.md](docs/Architecture.md) | System diagram and the rationale for each major design choice (local admin, JSON-as-DB, no CDN, refresh-based updates). |
| [docs/Dev-deploy-test.md](docs/Dev-deploy-test.md) | Local dev workflow, AWS bootstrap commands, the operator's edit → publish loop, tear-down, and the test matrix. |
| [docs/API-endpoints.md](docs/API-endpoints.md) | HTTP API reference: `/api/state`, participants, groups, matches, knockout, publish, and the `/view/` dev preview mount. |
| [docs/Cost-analysis.md](docs/Cost-analysis.md) | Per-event AWS cost estimate (target: <$2 for the whole event). |
| [docs/Production-checklist.md](docs/Production-checklist.md) | Pre-event operational checklist: dress rehearsal, Wi-Fi-drop test, backup laptop, IAM scope, QR code. |

See also [CLAUDE.md](CLAUDE.md) for hard constraints (cost, single-operator, offline-tolerant) and feature-level details.

## Technology

| Piece | Role |
|---|---|
| **Node 20 + TypeScript (tsx)** | Runs the admin app directly — no build step. |
| **Fastify** | HTTP server for the admin API and the `/view/` dev mount of the result site. |
| **`@fastify/static`** | Serves `admin/public/` (admin UI) and `result-site/` (local preview). |
| **Zod** | Validates request bodies on every state-changing endpoint. |
| **csv-parse** | Parses the participant import CSV. |
| **nanoid** | Generates IDs for participants, groups, matches, rounds. |
| **JSON file (`admin/data/tournament.json`)** | Single source of truth. Atomic writes via tmp-file + rename. |
| **`@aws-sdk/client-s3`** | PUTs derived view JSONs and backups to S3 on Publish. |
| **S3 website hosting** | Hosts `index.html`, `knockout.html`, assets, and the `data/*.json` view files. No CloudFront, no ACM, no Route 53. |
| **Vanilla HTML/CSS/JS** | Both the admin UI (`admin/public/`) and the result site (`result-site/`). No React, no bundler. |
| **Vitest** | Tests for the pairing engines and the standings tiebreaker logic. |

## Workflow

### Dev

```bash
pnpm i
pnpm dev        # admin on http://localhost:37325
pnpm test       # vitest: pairing + standings
```

Preview the spectator view against live data at `http://localhost:37325/view/` — the admin app mounts `result-site/` and serves the same derived `data/*.json` files S3 would. No S3 needed for local dev; leave `TP_BUCKET` unset and the publish loop becomes a no-op.

### Operator loop during the event

1. Operator edits in the admin UI → API mutates `tournament.json` → `pendingChanges` counter bumps.
2. Header status light shows 🟡 pending.
3. Operator clicks **Publish** → admin derives `version.json` / `groups.json` / `knockout.json` and PUTs them to S3 in parallel.
4. Spectator browsers see the change the next time they refresh or reopen the page.

Wi-Fi drops are fine — edits keep working locally; `pendingChanges` accumulates; the next Publish flushes the whole snapshot.

### Deploy (once per event)

```bash
bash deploy/bootstrap-aws.sh    # creates bucket + IAM publisher user, prints creds
# paste creds into ~/.aws/credentials, fill .env (TP_BUCKET, TP_REGION, AWS_PROFILE)
pnpm publish-static             # uploads HTML/CSS/JS to S3
```

Tear down with `bash deploy/tear-down.sh` after the event.
