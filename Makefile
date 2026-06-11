SHELL       := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

# Use pnpm if available, fall back to npm
PKG := $(shell command -v pnpm >/dev/null 2>&1 && echo pnpm || echo npm)

# Pull TP_BUCKET / TP_REGION / AWS_PROFILE / PORT from .env if it exists
-include .env
export

PORT ?= 3000
BASE := http://localhost:$(PORT)

.DEFAULT_GOAL := help

.PHONY: help install dev test test-watch typecheck \
        bootstrap publish status force-publish backup tear-down \
        wipe-data clean

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
bootstrap: ## Create S3 bucket + IAM publisher user (idempotent)
	bash deploy/bootstrap-aws.sh

publish: ## Sync static public site (public-site/) to S3 — run after HTML/CSS/JS edits
	bash deploy/publish-static.sh

tear-down: ## Delete the S3 bucket + IAM user (interactive)
	bash deploy/tear-down.sh

## Live operations (admin must be running)
status: ## Show publish status JSON
	@curl -sS $(BASE)/api/publish/status | python3 -m json.tool

force-publish: ## Force an immediate S3 push, bypassing the debounce
	@curl -sS -X POST $(BASE)/api/publish/force | python3 -m json.tool

backup: ## Push a tournament.json snapshot to s3://$$TP_BUCKET/private/backups/
	@curl -sS -X POST $(BASE)/api/publish/backup | python3 -m json.tool

## Local data
wipe-data: ## Delete admin/data/ (tournament.json + backups) — asks first
	@read -rp "Delete admin/data/ ? [y/N] " r; \
	 [[ "$$r" =~ ^[yY] ]] && rm -rf admin/data && echo "deleted" || echo "skipped"

clean: ## Remove node_modules and admin/data
	rm -rf node_modules admin/data
