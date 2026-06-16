#!/usr/bin/env bash
set -euo pipefail

# Run the Horizon Harvester SDK example.
# Requires DATABASE_URL, GITHUB_TOKEN, HORIZON_DATABASE_URL, and
# HORIZON_GRAPH_DATABASE_URL in .env at the repo root. HORIZON_EMBED_* is optional
# (omit to run search in lexical-only mode).
#
# Scenarios (set HARVESTER_SCENARIO):
#   full     harvest then ask (default)
#   harvest  just run the harvester
#   ask      just run the librarian (after a harvest)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT/examples/horizon-harvester"
exec node --env-file="$REPO_ROOT/.env" sdk-app.js "$@"
