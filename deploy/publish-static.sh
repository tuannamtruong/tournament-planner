#!/usr/bin/env bash
# Sync the static result site (result-site/) to S3. Run after edits to the
# HTML/CSS/JS, NOT after data changes — the admin app pushes data/* itself.
#
# Reads TP_BUCKET / AWS_PROFILE from environment or .env.

set -euo pipefail

# Load .env if present (no error if missing)
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

: "${TP_BUCKET:?TP_BUCKET not set — run deploy/bootstrap-aws.sh first}"
: "${AWS_PROFILE:=tp}"
export AWS_PROFILE

echo "→ syncing result-site/ to s3://$TP_BUCKET/  (profile: $AWS_PROFILE)"

# HTML/JS/CSS — long-ish browser cache; admin app will only change these when
# the codebase is updated.
aws s3 sync result-site/ "s3://$TP_BUCKET/" \
  --exclude "data/*" \
  --cache-control "public, max-age=3600" \
  --delete

echo "✓ done. Public URL: http://$TP_BUCKET.s3-website.${TP_REGION:-eu-central-1}.amazonaws.com"
