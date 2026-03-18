#!/usr/bin/env bash
set -euo pipefail

# Run the DevOps Command Center SDK example.
# Requires DATABASE_URL and GITHUB_TOKEN in .env at the repo root.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT/examples/devops-command-center"
exec node --env-file="$REPO_ROOT/.env" sdk-app.js "$@"
