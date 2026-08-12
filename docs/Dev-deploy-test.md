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
# Updates appear after refreshing/reopening the spectator page following an
# admin edit. No S3, no fixture files to maintain.

# Tests
pnpm test             # vitest — pairing + standings (17 tests across 4 files)

# Screenshot the result-site against a hermetic seeded dataset
# (used to catch visual regressions in the group-stage tree and bracket
# layouts when changing result-site/assets/render-*.js or app.css)
node scripts/screenshot-views.mjs        # writes debug/screenshots/*.png
```

Requires Playwright's Chromium (`npm i` already pulls Playwright as a
devDependency; run `npx playwright install chromium` once to fetch the
browser, and `sudo npx playwright install-deps chromium` once for the apt
libs Chromium needs to launch on Ubuntu).

No build step anywhere. Edit a file, reload the page.

`admin/data/tournament.json` is created on first run from a seed template. To wipe: delete the file (or the whole `admin/data/` directory).

For local dev without AWS, leave `TP_BUCKET` unset — the admin app runs fully, the publish loop becomes a no-op, and the status light shows "AWS not configured (local only)".

## Seeding & local data

`admin/data/tournament.json` is the single source of truth. A few scripts populate or churn it for local testing — all write through `storage.mutate()` (atomic write + a pending-log snapshot), so they're undoable from the **Pending** tab and honour `TP_DATA_FILE` if you want to target a scratch file instead of the real one.

| Command | What it does |
|---|---|
| `make generate-data` (`SEED=n`) | Seed a demo roster — singles + doubles entries, clubs, check-in/fee data. Deterministic per seed. |
| `make import-data CSV=path` | Import/append a participant roster from a CSV (`name, club, category, class, seed`). Defaults to `data/ettlingen.csv`. |
| `npx tsx scripts/simulate-tournament.ts` (`SEED=n`) | **Rebuild** a whole tournament: partition participants into round-robin groups, play every match, then run a knockout per (category, class). Wipes existing groups/brackets first. |
| `make randomize-results` (`SEED=n`) | **Re-randomize results for the groups/brackets that already exist**, leaving their structure, members, pairings and seeding untouched. Overwrites every match each run; withdrawn players forfeit by walkover; byes are marked done; knockout rounds are re-played so winners propagate. Prints a notice and does nothing if no groups/brackets exist yet. |
| `make wipe-data` | Delete `admin/data/` (tournament.json + backups) — asks first. |

## Deployment to AWS

### One-time provisioning (per event)

The infra (bucket + publisher IAM user + inline publish policy) lives in one CloudFormation stack: `deploy/cloudformation.yaml`. The access key for the publisher user is created out-of-band in the console so it never touches CloudFormation state.

1. **Deploy the stack.** Creates the bucket (website hosting + public-read on `index.html`, `knockout.html`, `assets/*`, `data/*`) and the `tp-publisher` IAM user with an inline `s3:PutObject` policy scoped to `data/*`.

   ```bash
   aws cloudformation deploy \
     --template-file deploy/cloudformation.yaml \
     --stack-name tp-result \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides BucketName=tp-result-myevent PublisherUserName=tp-publisher
   ```

   Or `make cfn-deploy`. Stack outputs `BucketName` and `WebsiteURL` — copy them.

   Result-site URL: `http://<bucket>.s3-website.<region>.amazonaws.com`.

2. **Create the publisher access key in the console.** IAM → Users → `tp-publisher` → Security credentials → Create access key. Save the secret (shown once). Paste into `.env`:

   ```
   TP_BUCKET=tp-result-myevent
   TP_REGION=eu-central-1
   AWS_ACCESS_KEY_ID=AKIA...
   AWS_SECRET_ACCESS_KEY=...
   ```

3. **Upload the static result site** (HTML/CSS/JS — the admin app handles `data/*` itself):

   ```bash
   pnpm publish-static            # wraps deploy/publish-static.sh
   ```

   This sync uses your Dev credentials (account-admin) under the `tp-dev` AWS profile in `~/.aws/credentials`, not the publisher key — the publisher's inline policy is intentionally scoped to `data/*` only. Override the profile name with `AWS_PROFILE=<name>` if you've configured it differently.

### Operator workflow — how to push changes to AWS

The mental model: the admin app accumulates a `pendingChanges` counter as the operator edits. When the operator wants spectators to see the new state, they click **Publish** in the header. Pushing is explicit, not automatic.

**One-time, before the event:**

```bash
pnpm i                                      # or: npm i
make cfn-deploy                             # creates bucket + tp-publisher IAM user via CFN
# In the AWS console: IAM → Users → tp-publisher → create access key
cp .env.example .env && $EDITOR .env        # fill TP_BUCKET, TP_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
pnpm publish-static                         # uploads HTML/CSS/JS to S3
```

Verify by opening the printed website URL — you should see an empty group-stage page that says "waiting for data…".

**Every working session:**

```bash
pnpm dev                                    # admin app on http://localhost:37325
```

Header status light:
- 🟢 `Synced N seconds ago` — last Publish succeeded
- 🟡 `N change(s) pending` — edits since last push; click **Publish** to flush
- 🟡 `Pushing…` — in-flight `POST /api/publish/force`
- 🟡 `AWS not configured (local only)` — `TP_BUCKET` not set
- 🔴 `Push failed — <reason>` — `status.lastError` from the last attempt; click **Publish** again to retry (no automatic retry)
- **Publish** button next to it.

### Multiple operators (optional)

Several operators can edit the same tournament from separate laptops at once. Each laptop runs its own admin app with its own local `tournament.json`; they reconcile through a shared canonical copy with optimistic, per-record concurrency (no locks). This is off unless a shared store is configured.

**Setup (S3, the production path):**

1. Deploy/refresh the stack so the publisher key can read+write the canonical state: `make cfn-deploy` (grants `s3:GetObject`/`s3:PutObject` on `private/state/*`).
2. On every laptop, set in `.env`: the same `TP_BUCKET`/`TP_REGION` and operator key, plus a unique **`TP_NODE_ID`** (e.g. `front-desk`, `court-5`). Optionally `TP_STATE_KEY` (default `private/state/tournament.json`) — must match across laptops.
3. `pnpm dev` on each. The header shows a second light: 🟢 `Synced · <nodeId>` / 🟡 `Sync offline` / 🔴 `N sync conflict(s)`.

**How it behaves:**
- Edits to *different* records (e.g. two scorekeepers scoring different matches) merge automatically — no conflict.
- Two operators editing the *same* record: the first write wins; the second gets a **"Someone else updated this — reloaded"** toast (the local 409 path) or, after an offline divergence, the merge keeps the newer edit (by timestamp) and pops a **sync conflict** toast naming the record.
- Offline (Wi-Fi flaps): keep editing; the laptop reconciles automatically when it reconnects.

**Zero-AWS alternative / local testing:** set `TP_SYNC_DIR=/path/to/shared/folder` (a LAN file share) on every laptop instead of `TP_BUCKET`. Same If-Match contract, no S3. This is what `tests/sync.test.mjs` uses to drive two laptops; for a manual two-laptop demo:

```bash
DIR=$(mktemp -d)
TP_SYNC_DIR=$DIR TP_NODE_ID=A PORT=37325 TP_DATA_FILE=/tmp/a.json pnpm start &
TP_SYNC_DIR=$DIR TP_NODE_ID=B PORT=37326 TP_DATA_FILE=/tmp/b.json pnpm start &
# edit in one tab (:37325), watch it appear in the other (:37326)
```

**What happens on each edit:**

```
operator edits a score in the browser
        │
        ▼
PATCH /api/groups/:gid/matches/:mid
        │
        ▼
storage.mutate():
  clone current state (= pre-mutation snapshot)
  validate → write tmp file → rename tournament.json → cache
  append { snapshot, action, target, payload } to admin/data/pending.json
        │
        ▼
status.pendingChanges (= length of pending log) increases by 1
        │
        ▼
operator clicks "Publish" → POST /api/publish/force
        │
        ▼
publish.runPublish():
  load tournament.json
  derive { version.json, groups.json, knockout.json }
  Promise.all PUT to S3 with Cache-Control headers
        │
        ├─ success → status.lastSuccess = now; pending.json cleared
        └─ failure → status.lastError; throws 502 (no auto-retry)
```

**When Wi-Fi drops:** edits keep working (local JSON), `pendingChanges` increments, the light shows pending. When connectivity returns, the operator clicks **Publish**; each push is a full snapshot of the current views, so the publisher doesn't need a per-edit queue.

**Undo:** the pending log doubles as an undo journal. The **Pending** tab lists every unpublished mutation with a human summary; **Revert from here** restores `tournament.json` to that entry's pre-mutation snapshot and discards every change after it (linear undo). **Revert all** restores the last-published baseline. The log is cleared by a successful Publish.

**Backup pushes (separate path):** the Settings tab has a manual **Push backup snapshot** button that PUTs a full `tournament.json` to `s3://$BUCKET/private/backups/tournament-<ts>.json` via `publish.pushBackup()`. The bucket policy denies public read on `private/*`. Locally, `storage.startLocalSnapshots()` writes a snapshot to `admin/data/backups/` every 5 minutes and keeps the last 50 — that's the disk-side safety net.

### Tear-down

CloudFormation tears down the bucket + IAM user + inline policy in one shot, but the bucket must be empty first (the stack's `DeletionPolicy: Delete` won't remove a non-empty bucket). The access key on the publisher user also has to be deleted by hand — it was created out-of-band in the console, so CFN doesn't know about it.

```bash
make cfn-delete                             # empties bucket (prompts), then deletes the stack
```

or by hand:

```bash
aws s3 rm s3://$TP_BUCKET --recursive
# In the console: IAM → Users → tp-publisher → delete the access key
aws cloudformation delete-stack --stack-name tp-result
```


## Tests

| File | Covers |
|---|---|
| `admin/src/pairing/round_robin.test.ts` | empty input; even N → N-1 rounds, complete schedule, no duplicates; odd N → N rounds with one bye per round and per player; determinism |
| `admin/src/pairing/swiss.test.ts` | top-with-next pairing; rematch avoidance; bye picks lowest unbyed; fallback when everyone has a bye; throws on impossible board |
| `admin/src/pairing/index.test.ts` | withdrawal handling in `generateNextRound`: withdrawn players are skipped without breaking the schedule |
| `admin/src/standings.test.ts` | wins-first ordering; tied-on-wins broken by set diff; head-to-head as final tiebreaker; pending matches ignored |
| `admin/src/merge.test.ts` | 3-way per-record merge: local/remote-only edits, disjoint adds, same-record conflict (LWW), add-vs-delete, global rev bump |
| `tests/concurrency.test.mjs` | per-record rev bump, `GET /api/state/rev`, stale `baseRev` → 409 with current record (no clobber), disjoint edits don't collide |
| `tests/sync.test.mjs` | two-laptop convergence over a shared folder (`FilesystemStore`, same If-Match contract as S3): edits propagate, concurrent disjoint adds converge, no spurious conflicts |

End-to-end smoke runs out of band via `node tests/run-all.mjs` — each `tests/*.test.mjs` boots a real Fastify on a random port against a temp `TP_DATA_FILE` and asserts one feature area; together they walk the full lifecycle (rename → participants → group → next-round → score → bracket → /view JSONs → pending log + linear-undo, plus a Playwright tab-jump UI check). Run it before touching anything in `admin/src/routes/`. See `tests/README.md` for the per-script table.

Add new tests when changing pairing or standings logic. Other modules (CRUD routes, UI) are fine without tests.

