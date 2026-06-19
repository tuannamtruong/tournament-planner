# Tournament Planner

A small web app for running a badminton-style tournament.

Two web sites:

- **Admin site** — Fastify app running on the tournament director's laptop at `http://localhost:37325`. Owns the source of truth, imports participants, builds groups, runs pairings, enters scores, manages the knockout.
- **Result site** — read-only static result hosted on S3. 

There is no backend in AWS. The admin app derives view JSONs and PUTs them to S3 when the operator clicks **Publish**.

## Docs

| File | What's in it |
|---|---|
| [docs/Requirements.md](docs/Requirements.md) | Reverse-spec of the shipped app: stakeholders, hard constraints, functional + non-functional requirements, data model. |
| [docs/Features.md](docs/Features.md) | Screen-by-screen feature walkthrough of the admin and result surfaces, with screenshots. |
| [docs/Storyboard.md](docs/Storyboard.md) | Plain-language, scene-by-scene story of a tournament day for non-technical readers. |
| [docs/Architecture.md](docs/Architecture.md) | System diagram and the rationale for each major design choice (local admin, JSON-as-DB, no CDN, refresh-based updates). |
| [docs/Dev-deploy-test.md](docs/Dev-deploy-test.md) | Local dev workflow, CloudFormation deploy, the operator's edit → publish loop, tear-down, and the test matrix. |
| [docs/API-endpoints.md](docs/API-endpoints.md) | HTTP API reference: `/api/state`, participants, groups, matches, knockout, publish, and the `/view/` dev preview mount. |
| [docs/Cost-analysis.md](docs/Cost-analysis.md) | Per-event AWS cost estimate (target: <$2 for the whole event). |
| [docs/Production-checklist.md](docs/Production-checklist.md) | Pre-event operational checklist: dress rehearsal, Wi-Fi-drop test, backup laptop, IAM scope, QR code. |
| [CLAUDE.md](CLAUDE.md) | hard constraints, cost, single-operator, offline-tolerant and feature-level details. |

## Principals

Four roles interact with the system. They may collapse onto the same person at a small event, but the responsiblities are distinct.

| Role | What they do | AWS credentials |
|---|---|---|
| **Dev** | Responsibilty for dev and infra; builds the Windows portable bundle. | Account-admin creds. Stay on the Dev machine; never in the operator laptop. |
| **Admin** | Installs the portable bundle on the operator's laptop. Handle of `.env`. smoke-tests the result-site URL, and applies in-event updates if needed. | None. |
| **Operator** (**Publisher**) | Runs the admin app during the event: imports participants, builds groups, runs pairings, enters scores, publish result. | The `tp-publisher` access key, in `.env`. Least-privilege: `s3:PutObject` on `data/*` only. |
| **Viewer** | Players, spectators, anyone with the public URL. | None. |

## Workflow

> The runnable project lives in **`app/`** (source, `package.json`, `Makefile`, `.env`). Run all `pnpm`/`make` commands below from there — `cd app` first, or use `pnpm --prefix app …` / `make -C app …`. Only `README.md` and `docs/` live at the repo root.

### Dev

```bash
cd app
pnpm i
pnpm dev        # admin on http://localhost:37325
pnpm test       # vitest: pairing + standings
```

Preview the spectator view against live data at `http://localhost:37325/view/` — the admin app mounts `app/result-site/` and serves the same derived `data/*.json` files S3 would. No S3 needed for local dev; leave `TP_BUCKET` unset and the publish loop becomes a no-op.

### Setup

1. **Provision infra with CloudFormation.** The stack creates the bucket and the `tp-publisher` IAM user with an inline publish policy scoped to `data/*`:
    `make cfn-deploy`.
2. **Console — create the publisher access key.** Create access key for `tp-publisher`. Pass `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` into `.env`.
3. **Upload the static result site.**
   ```bash
   pnpm publish-static
   ```

### Operatorional

1. Operator edits in the admin UI locally → API mutates `tournament.json`, appends a pre-mutation snapshot to `app/admin/data/pending.json` → `pendingChanges` counter (= log length) bumps.
2. Header status light shows 🟡 pending. The **Pending** tab lists every unpublished change.
3. Operator clicks **Publish** → admin derives `version.json` / `groups.json` / `knockout.json` and PUTs them to S3 in parallel; the pending log is cleared on success.
4. Spectator browsers see the change the next time they refresh or reopen the page.

### Teardown
Empty the bucket, delete the publisher access key in the console, then `make cfn-delete`.

## Technology

| Piece | Role |
|---|---|
| **Node 20 + TypeScript (tsx)** | Runs the admin app directly — no build step. |
| **Fastify** | HTTP server for the admin API and the `/view/` dev mount of the result site. |
| **`@fastify/static`** | Serves `app/admin/public/` (admin UI) and `app/result-site/` (local preview). |
| **Zod** | Validates request bodies on every state-changing endpoint. |
| **csv-parse** | Parses the participant import CSV. |
| **nanoid** | Generates IDs for participants, groups, matches, rounds. |
| **JSON file (`app/admin/data/tournament.json`)** | Single source of truth. Atomic writes via tmp-file + rename. |
| **`@aws-sdk/client-s3`** | PUTs derived view JSONs and backups to S3 on Publish. |
| **S3 website hosting** | Hosts `index.html`, `knockout.html`, assets, and the `data/*.json` view files. No CloudFront, no ACM, no Route 53. |
| **Vanilla HTML/CSS/JS** | Both the admin UI (`app/admin/public/`) and the result site (`app/result-site/`). No React, no bundler. |
| **Vitest** | Tests for the pairing engines and the standings tiebreaker logic. |
