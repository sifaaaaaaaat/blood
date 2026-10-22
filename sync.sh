#!/usr/bin/env bash
# Sync mode: commit everything and push to GitHub (Vercel auto-deploys after push).
# Usage: bash sync.sh "optional commit message here"
set -euo pipefail
msg="${1:-Sync: auto-save changes}"
cd "$(dirname "$0")"
git add -A
git commit -m "$msg" >/dev/null 2>&1 || true
git push
echo "Pushed. Vercel will deploy automatically."
