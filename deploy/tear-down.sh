#!/usr/bin/env bash
# Delete everything bootstrap-aws.sh created. Prompts before each step.
#
# Usage:
#   BUCKET=tp-public-xxxx bash deploy/tear-down.sh

set -euo pipefail

if [ -f .env ]; then set -a; . ./.env; set +a; fi
BUCKET="${BUCKET:-${TP_BUCKET:-}}"
IAM_USER="${IAM_USER:-tp-publisher-${BUCKET}}"

: "${BUCKET:?Set BUCKET=... or TP_BUCKET in .env}"

confirm() { read -p "  $1 [y/N] " r; [[ "$r" =~ ^[yY] ]]; }

echo "About to tear down:"
echo "  bucket:    $BUCKET (and all contents)"
echo "  iam user:  $IAM_USER"
echo

if confirm "Empty the bucket?"; then
  aws s3 rm "s3://$BUCKET" --recursive || true
fi
if confirm "Delete the bucket?"; then
  aws s3 rb "s3://$BUCKET" || true
fi
if confirm "Delete IAM user $IAM_USER (revokes the publisher key)?"; then
  for k in $(aws iam list-access-keys --user-name "$IAM_USER" --query 'AccessKeyMetadata[].AccessKeyId' --output text 2>/dev/null || true); do
    aws iam delete-access-key --user-name "$IAM_USER" --access-key-id "$k" || true
  done
  aws iam delete-user-policy --user-name "$IAM_USER" --policy-name tp-publish 2>/dev/null || true
  aws iam delete-user --user-name "$IAM_USER" || true
fi

echo "✓ tear-down done."
