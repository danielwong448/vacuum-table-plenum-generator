#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "Running verification suite before deploy..."
node tests/verify.js

if ! git remote get-url origin >/dev/null 2>&1; then
  echo ""
  echo "No 'origin' remote is configured yet."
  echo "Connect your GitHub repository and push with:"
  echo "  git remote add origin https://github.com/<your-username>/vacuum-table-plenum-generator.git"
  echo "  git push -u origin main"
  exit 1
fi

git add -A
if ! git diff --cached --quiet; then
  MSG="${1:-Update Vacuum Table Plenum Generator ($(date '+%Y-%m-%d %H:%M'))}"
  git commit -m "$MSG"
fi

echo "Pushing to GitHub Pages (origin main)..."
git push -u origin main
echo "Done! GitHub Pages will rebuild within ~1-2 minutes."
