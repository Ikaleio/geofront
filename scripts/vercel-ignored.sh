#!/usr/bin/env bash
# Exit 0 to skip build (ignored), exit 1 to force build (non-ignored)
set -euo pipefail

# Vercel provides these env vars:
#   VERCEL_GIT_COMMIT_MESSAGE
#   VERCEL_GIT_COMMIT_REF
#   VERCEL_GIT_COMMIT_SHA

msg="${VERCEL_GIT_COMMIT_MESSAGE:-}" 

if [[ -z "$msg" ]]; then
  echo "No commit message found; build anyway" >&2
  exit 1
fi

if [[ "$msg" =~ ^docs: || "$msg" =~ ^v[0-9]+\.[0-9]+\.[0-9]+($|\s) ]]; then
  echo "docs: prefix detected or version tag detected -> run deployment"
  exit 1
else
  echo "Commit message does not match criteria -> skip build"
  exit 0
fi
