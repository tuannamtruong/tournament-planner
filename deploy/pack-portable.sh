#!/usr/bin/env bash
# Build a portable Windows x64 bundle of the admin app.
#
# Output:  dist/tournament-planner-portable-win-x64.zip
# Contents: node.exe + source + node_modules (with Windows-flavored binaries) +
#           result-site/ + start.bat + .env.example + README-portable.md
#
# The target laptop needs nothing pre-installed. Operator workflow:
#   1. Unzip
#   2. Copy .env.example to .env and fill in TP_BUCKET / TP_REGION / AWS_PROFILE
#   3. Put the [tp] block into %USERPROFILE%\.aws\credentials
#   4. Double-click start.bat
#
# Requires (on the build host): bash, curl, unzip, npm, and either `zip` or `python3`.

set -euo pipefail

NODE_VERSION="${NODE_VERSION:-20.18.1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="$HERE/.pack-cache"
STAGE="$HERE/dist/tp-portable"
ZIP_OUT="$HERE/dist/tp-portable-w64.zip"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  • %s\n' "$*"; }

bold "Node version: $NODE_VERSION (win-x64)"
bold "Staging dir:  $STAGE"
bold "Output:       $ZIP_OUT"
echo

mkdir -p "$CACHE" "$HERE/dist"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# --- 1. Download Windows Node -------------------------------------------------
NODE_ZIP="$CACHE/node-v${NODE_VERSION}-win-x64.zip"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip"
if [ ! -f "$NODE_ZIP" ]; then
  info "downloading $NODE_URL"
  curl -fLo "$NODE_ZIP" "$NODE_URL"
else
  info "using cached $NODE_ZIP"
fi

info "extracting node.exe"
unzip -q -o "$NODE_ZIP" "node-v${NODE_VERSION}-win-x64/node.exe" -d "$CACHE"
cp "$CACHE/node-v${NODE_VERSION}-win-x64/node.exe" "$STAGE/node.exe"

# --- 2. Copy source -----------------------------------------------------------
info "copying source"
cp -r "$HERE/admin" "$STAGE/admin"
cp -r "$HERE/result-site" "$STAGE/result-site"
cp    "$HERE/package.json" "$HERE/package-lock.json" "$HERE/tsconfig.json" "$STAGE/"
cp    "$HERE/.env.example" "$STAGE/"
if [ -f "$HERE/.env" ]; then
  info "bundling .env (contains AWS credentials — do not share this zip publicly)"
  cp "$HERE/.env" "$STAGE/.env"
fi

# Drop dev-only stuff that may have been copied with admin/
rm -rf "$STAGE/admin/data"                       # created fresh on first run
find "$STAGE/admin" -name '*.test.ts' -delete    # tests not needed at runtime

# --- 3. Install Windows-flavored node_modules --------------------------------
info "installing node_modules (this fetches deps fresh, may take 30-60s)"
( cd "$STAGE" && npm ci --include=dev --no-audit --no-fund --silent )

# esbuild (transitive via tsx) ships per-OS native binaries via optional deps.
# On a Linux build host npm only pulls @esbuild/linux-x64 — we need the win32
# variant for the target. --force lets npm install it despite the os mismatch.
ESBV=$(node -p "require('$STAGE/node_modules/@esbuild/linux-x64/package.json').version" 2>/dev/null || echo "")
if [ -n "$ESBV" ]; then
  info "injecting @esbuild/win32-x64@$ESBV"
  ( cd "$STAGE" && npm install "@esbuild/win32-x64@$ESBV" \
      --force --no-save --no-audit --no-fund --silent )
  info "removing unused linux esbuild binary"
  rm -rf "$STAGE/node_modules/@esbuild/linux-x64"
fi

# --- 3b. Prune dev-only / declaration-only files ------------------------------
# Windows has a 260-char MAX_PATH limit. AWS SDK ships very deep dist-types/
# trees full of .d.ts files that aren't needed at runtime — they push the
# longest paths in the bundle past 260 chars once the operator extracts into
# any non-trivial folder, and Windows Explorer silently skips the overflowing
# entries (often abandoning the rest of the extraction with it).
info "pruning .d.ts / dist-types / sourcemaps from node_modules"
find "$STAGE/node_modules" -type f \( \
    -name '*.d.ts' -o -name '*.d.cts' -o -name '*.d.mts' \
    -o -name '*.map' \
  \) -delete
find "$STAGE/node_modules" -type d -name 'dist-types' -prune -exec rm -rf {} +
# Empty dirs left behind after the file sweep
find "$STAGE/node_modules" -type d -empty -delete

LONGEST=$(find "$STAGE" -printf '%P\n' | awk '{ print length($0), $0 }' | sort -rn | awk 'NR==1 { print; exit }' || true)
info "longest in-bundle path after prune: $LONGEST"

# --- 4. Windows launcher ------------------------------------------------------
info "writing start.bat"
cat > "$STAGE/start.bat" <<'BAT'
@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist ".env" (
  echo.
  echo  ERROR: .env not found.
  echo  Copy .env.example to .env and fill in TP_BUCKET, TP_REGION, AWS_PROFILE.
  echo.
  pause
  exit /b 1
)

rem Load .env (KEY=VALUE per line, # comments and blanks skipped)
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
  set "key=%%a"
  set "val=%%b"
  if defined key (
    if not "!key:~0,1!"=="#" (
      if not "!key!"=="" set "!key!=!val!"
    )
  )
)

if not exist "admin\data" mkdir "admin\data"

if not defined PORT set "PORT=37325"

echo.
echo  Tournament Planner — admin running at http://localhost:%PORT%
echo  Press Ctrl+C to stop.
echo.

".\node.exe" "node_modules\tsx\dist\cli.mjs" "admin\src\index.ts"
BAT

# --- 5. Operator README -------------------------------------------------------
info "writing README-portable.md"
cat > "$STAGE/README-portable.md" <<'MD'
# Tournament Planner — Portable (Windows x64)

Everything needed to run the admin app on a Windows laptop. No Node, npm, or
AWS CLI install required.

## First-time setup

1. **Unzip** this folder anywhere (Desktop is fine).
2. **Configure**: copy `.env.example` to `.env` and fill in:
   - `TP_BUCKET` — the S3 bucket name output by the CFN stack
   - `TP_REGION` — the bucket's region (e.g. `eu-central-1`)
   - `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — the publisher access key
     (Dev creates it in the AWS console on the `tp-publisher` user and hands
     it over). The SDK picks them up from `.env`, no `~/.aws/credentials` file
     is needed on the operator's laptop.
3. **Run**: double-click `start.bat`. A console window opens and stays open.
4. Open `http://localhost:37325` in any browser.

## Day-of-event

- Just double-click `start.bat`.
- Tournament data lives in `admin\data\tournament.json` next to `start.bat` —
  back it up by copying that file (Settings tab also has a manual backup push).
- Closing the console window stops the server.

## Troubleshooting

- **"AWS not configured (local only)"** in the header — `.env` is missing or
  `TP_BUCKET` is empty. The app still works for local data entry.
- **"Push failed"** — check that `.env` has `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` filled in and the key is still active; check Wi-Fi.
- **Port 37325 in use** — set `PORT=12345` (or any free port) in `.env`.
MD

# --- 6. Zip -------------------------------------------------------------------
info "zipping bundle"
rm -f "$ZIP_OUT"
if command -v zip >/dev/null 2>&1; then
  ( cd "$HERE/dist" && zip -qr "$(basename "$ZIP_OUT")" "$(basename "$STAGE")" )
else
  ( cd "$HERE/dist" && python3 -c "
import os, sys, zipfile
root = sys.argv[1]
out = sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for base, _, files in os.walk(root):
        for f in files:
            p = os.path.join(base, f)
            z.write(p, os.path.relpath(p, '.'))
" "$(basename "$STAGE")" "$(basename "$ZIP_OUT")" )
fi

SIZE=$(du -h "$ZIP_OUT" | cut -f1)
echo
bold "✓ Pack complete: $ZIP_OUT ($SIZE)"
echo
bold "Next:"
echo "  1. Copy the zip to the director's laptop"
echo "  2. Unzip, fill in .env (TP_BUCKET + publisher access key)"
echo "  3. Double-click start.bat"
