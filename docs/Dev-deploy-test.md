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
pnpm test             # vitest — pairing + standings (13 tests)
```

No build step anywhere. Edit a file, reload the page.

`admin/data/tournament.json` is created on first run from a seed template. To wipe: delete the file (or the whole `admin/data/` directory).

For local dev without AWS, leave `TP_BUCKET` unset — the admin app runs fully, the publish loop becomes a no-op, and the status light shows "AWS not configured (local only)".

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

   This sync uses your Dev credentials (account-admin), not the publisher key — the publisher's inline policy is intentionally scoped to `data/*` only.

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
        │  (just bumps status.pendingChanges; no push scheduled)
        ▼
operator clicks "Publish" → POST /api/publish/force
        │
        ▼
publish.runPublish():
  load tournament.json
  derive { version.json, groups.json, knockout.json }
  Promise.all PUT to S3 with Cache-Control headers
        │
        ├─ success → status.lastSuccess = now; pendingChanges -= snapshot
        └─ failure → status.lastError; throws 502 (no auto-retry)
```

**When Wi-Fi drops:** edits keep working (local JSON), `pendingChanges` increments, the light shows pending. When connectivity returns, the operator clicks **Publish**; each push is a full snapshot of the current views, so no per-edit queue is needed.

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
| `admin/src/standings.test.ts` | wins-first ordering; tied-on-wins broken by set diff; head-to-head as final tiebreaker; pending matches ignored |

Add new tests when changing pairing or standings logic. Other modules (CRUD routes, UI) are fine without tests.

