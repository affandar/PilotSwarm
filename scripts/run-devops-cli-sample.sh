#!/usr/bin/env bash
set -euo pipefail

# Run the PilotSwarm CLI with the DevOps Command Center plugin + tools.
# Requires DATABASE_URL and GITHUB_TOKEN in .env at the repo root.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

exec node "$REPO_ROOT/packages/cli/bin/tui.js" \
  --env "$REPO_ROOT/.env" \
  --plugin "$REPO_ROOT/examples/devops-command-center/plugin" \
  --worker "$REPO_ROOT/examples/devops-command-center/worker.js" \
  "$@"
