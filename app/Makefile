SHELL       := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

# Use pnpm if available, fall back to npm
PKG := $(shell command -v pnpm >/dev/null 2>&1 && echo pnpm || echo npm)

# Pull TP_BUCKET / TP_REGION / AWS_PROFILE / PORT from .env if it exists
-include .env
export

PORT ?= 37325
BASE := http://localhost:$(PORT)

.DEFAULT_GOAL := help

.PHONY: help install dev test test-watch typecheck \
        cfn-deploy publish status force-publish backup cfn-delete \
        generate-data import-data wipe-data clean

STACK_NAME    ?= tp-stm-result-stack
BUCKET_PARAM  ?= $(TP_BUCKET)
PUBLISHER     ?= tp-operator

help: ## Show available targets
	@awk 'BEGIN { FS = ":.*##"; printf "Tournament Planner — make targets\n\nUsage: make <target>\n\n" } \
	     /^[a-zA-Z_-]+:.*##/ { printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2 } \
	     /^## / { printf "\n\033[1m%s\033[0m\n", substr($$0, 4) }' \
	     $(MAKEFILE_LIST)

## Development
install: ## Install JS dependencies
	$(PKG) install

dev: ## Run admin app with file watch (http://localhost:$(PORT))
	$(PKG) run dev

test: ## Run vitest once (pairing + standings)
	$(PKG) test

test-watch: ## Run vitest in watch mode
	$(PKG) run test:watch

typecheck: ## Type-check without emitting JS
	npx tsc --noEmit

## AWS provisioning
cfn-deploy: ## Deploy/update the CloudFormation stack (bucket + tp-publisher IAM user)
	aws cloudformation deploy \
	  --template-file deploy/cloudformation.yaml \
	  --stack-name $(STACK_NAME) \
	  --capabilities CAPABILITY_NAMED_IAM \
	  $(if $(BUCKET_PARAM),--parameter-overrides BucketName=$(BUCKET_PARAM) PublisherUserName=$(PUBLISHER))

publish: ## Sync static result site (result-site/) to S3 — run after HTML/CSS/JS edits
	bash deploy/publish-static.sh

cfn-delete: ## Empty the bucket and delete the CloudFormation stack (prompts)
	@: "$${TP_BUCKET:?TP_BUCKET not set — needed to empty the bucket}"
	@read -rp "Empty s3://$(TP_BUCKET) and delete stack $(STACK_NAME)? [y/N] " r; \
	 [[ "$$r" =~ ^[yY] ]] || { echo "skipped"; exit 0; }; \
	 aws s3 rm s3://$(TP_BUCKET) --recursive || true; \
	 aws cloudformation delete-stack --stack-name $(STACK_NAME); \
	 echo "stack delete requested — note: the publisher access key was created out-of-band, delete it manually in the console"

## Live operations (admin must be running)
status: ## Show publish status JSON
	@curl -sS $(BASE)/api/publish/status | python3 -m json.tool

force-publish: ## Force an immediate S3 push, bypassing the debounce
	@curl -sS -X POST $(BASE)/api/publish/force | python3 -m json.tool

backup: ## Push a tournament.json snapshot to s3://$$TP_BUCKET/private/backups/
	@curl -sS -X POST $(BASE)/api/publish/backup | python3 -m json.tool

## Local data
generate-data: ## Seed admin/data with a demo roster (singles + doubles, clubs, check-in/fees). SEED=n for a variant
	npx tsx scripts/generate-data.ts

import-data: ## Import a roster CSV into admin/data (appends). CSV=path overrides data/ettlingen.csv
	npx tsx scripts/import-csv.ts $(CSV)

wipe-data: ## Delete admin/data/ (tournament.json + backups) — asks first
	@read -rp "Delete admin/data/ ? [y/N] " r; \
	 [[ "$$r" =~ ^[yY] ]] && rm -rf admin/data && echo "deleted" || echo "skipped"

clean: ## Remove node_modules and admin/data
	rm -rf node_modules admin/data
