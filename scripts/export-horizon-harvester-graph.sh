#!/usr/bin/env bash
set -euo pipefail

# Export the harvested knowledge graph to a Markdown file with a Mermaid diagram.
# Requires HORIZON_GRAPH_DATABASE_URL (or HORIZON_DATABASE_URL) in .env at the repo
# root. Run a harvest first with ./scripts/run-horizon-harvester-sample.sh.
#
# Output path: first arg, else HARVESTER_GRAPH_MD env, else examples/horizon-harvester/graph.md
#
#   ./scripts/export-horizon-harvester-graph.sh
#   ./scripts/export-horizon-harvester-graph.sh /tmp/northwind-graph.md

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT/examples/horizon-harvester"
exec node --env-file="$REPO_ROOT/.env" scripts/graph-to-mermaid.mjs "$@"
