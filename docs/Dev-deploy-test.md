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

The mental model: the admin app accumulates a `pendingChanges` counter as the operator edits. When the operator wants spectators to see the new state, they click **Publish** in the header. Pushing is explicit, not automatic.

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


## Tests

| File | Covers |
|---|---|
| `admin/src/pairing/round_robin.test.ts` | empty input; even N → N-1 rounds, complete schedule, no duplicates; odd N → N rounds with one bye per round and per player; determinism |
| `admin/src/pairing/swiss.test.ts` | top-with-next pairing; rematch avoidance; bye picks lowest unbyed; fallback when everyone has a bye; throws on impossible board |
| `admin/src/standings.test.ts` | wins-first ordering; tied-on-wins broken by set diff; head-to-head as final tiebreaker; pending matches ignored |

Add new tests when changing pairing or standings logic. Other modules (CRUD routes, UI) are fine without tests.

