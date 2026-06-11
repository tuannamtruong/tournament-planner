#!/usr/bin/env bash
# One-shot provisioning for the result-site S3 bucket + IAM user.
# Idempotent: re-running is safe; existing resources are detected and reused.
#
# Requires: aws CLI configured with admin-ish credentials (only needed once,
# to create the publisher IAM user). After this, only the publisher key is used.
#
# Usage:
#   REGION=eu-central-1 BUCKET=tp-result-myevent bash deploy/bootstrap-aws.sh
# Or omit BUCKET to auto-generate a random suffix.
#
# On success it prints:
#   - the result-site website URL
#   - an aws_access_key_id / aws_secret_access_key block to paste into ~/.aws/credentials
#   - the env vars to export

set -euo pipefail

REGION="${REGION:-eu-central-1}"
BUCKET="${BUCKET:-tp-result-$(openssl rand -hex 4)}"
IAM_USER="${IAM_USER:-tp-publisher-${BUCKET}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  • %s\n' "$*"; }

bold "Region: $REGION"
bold "Bucket: $BUCKET"
bold "IAM user: $IAM_USER"
echo

# --- 1. Bucket ---------------------------------------------------------------
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  info "bucket already exists, skipping create"
else
  info "creating bucket"
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
  fi
fi

info "disabling public-access block (required for website hosting)"
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false"

info "applying bucket policy (public read for index/knockout/assets/data only)"
sed "s/BUCKET_NAME/$BUCKET/g" "$HERE/s3-bucket-policy.json" > /tmp/tp-bucket-policy.json
aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///tmp/tp-bucket-policy.json

info "enabling website hosting"
aws s3 website "s3://$BUCKET/" --index-document index.html --error-document index.html

info "ensuring versioning is OFF (avoids cost creep)"
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Suspended

# --- 2. IAM publisher user ---------------------------------------------------
if aws iam get-user --user-name "$IAM_USER" 2>/dev/null >/dev/null; then
  info "iam user already exists, skipping create"
else
  info "creating iam user $IAM_USER"
  aws iam create-user --user-name "$IAM_USER" >/dev/null
fi

info "attaching inline publish policy"
sed "s/BUCKET_NAME/$BUCKET/g" "$HERE/iam-policy.json" > /tmp/tp-iam-policy.json
aws iam put-user-policy --user-name "$IAM_USER" \
  --policy-name tp-publish --policy-document file:///tmp/tp-iam-policy.json

EXISTING_KEYS=$(aws iam list-access-keys --user-name "$IAM_USER" \
  --query 'AccessKeyMetadata[].AccessKeyId' --output text)
if [ -n "$EXISTING_KEYS" ]; then
  info "iam user already has an access key — not creating a new one"
  info "  (key id(s): $EXISTING_KEYS)"
  KEY_OUT=""
else
  info "creating access key"
  KEY_OUT=$(aws iam create-access-key --user-name "$IAM_USER" --output json)
fi

# --- 3. Summary --------------------------------------------------------------
WEBSITE_URL="http://$BUCKET.s3-website.$REGION.amazonaws.com"
if [ "$REGION" = "us-east-1" ]; then
  WEBSITE_URL="http://$BUCKET.s3-website-us-east-1.amazonaws.com"
fi

echo
bold "✓ Bootstrap complete."
echo
bold "Public URL:"
echo "  $WEBSITE_URL"
echo
bold "Env vars to export (also paste into .env):"
echo "  export TP_BUCKET=$BUCKET"
echo "  export TP_REGION=$REGION"
echo "  export AWS_PROFILE=tp"
echo

if [ -n "$KEY_OUT" ]; then
  ACCESS_KEY=$(printf '%s' "$KEY_OUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["AccessKey"]["AccessKeyId"])')
  SECRET_KEY=$(printf '%s' "$KEY_OUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["AccessKey"]["SecretAccessKey"])')
  bold "Paste into ~/.aws/credentials (SAVE THE SECRET — it is shown only once):"
  echo
  echo "[tp]"
  echo "aws_access_key_id     = $ACCESS_KEY"
  echo "aws_secret_access_key = $SECRET_KEY"
  echo
fi

bold "Next steps:"
echo "  1. (If a new access key was just printed) save it to ~/.aws/credentials."
echo "  2. Sync the static result site:    pnpm publish-static"
echo "  3. Start the local admin app:       pnpm dev"
echo "  4. Open the public URL to verify:   $WEBSITE_URL"
