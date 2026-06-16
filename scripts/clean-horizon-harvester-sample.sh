#!/usr/bin/env bash
set -euo pipefail

# Clean up the Horizon Harvester sample. Three escalating levels:
#
#   (no args)   Local only — drop the local duroxide + copilot_sessions schemas
#               and session files. HorizonDB facts + graph are NOT touched.
#   --facts     The above, plus delete this sample's corpus/northwind facts from
#               HorizonDB (keeps the schema + the durable embedder loop).
#   --drop      FULL teardown — the above local cleanup, plus cancel the durable
#               embedder loop, drop the AGE graph (horizon_graph), and DROP SCHEMA
#               horizon_facts CASCADE. Use this to start completely clean.
#
# Requires DATABASE_URL (+ HORIZON_DATABASE_URL / HORIZON_GRAPH_DATABASE_URL for
# the --facts / --drop levels) in .env at the repo root.
#
#   ./scripts/clean-horizon-harvester-sample.sh           # local only
#   ./scripts/clean-horizon-harvester-sample.sh --facts   # + delete corpus facts
#   ./scripts/clean-horizon-harvester-sample.sh --drop    # full teardown

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MODE="${1:-local}"
case "$MODE" in
    local|"")        ;;
    --facts|facts)   export HARVESTER_CLEAN_HORIZON=1 ;;
    --drop|--all|drop) export HARVESTER_DROP_HORIZON=1 ;;
    -h|--help)
        sed -n '3,18p' "$0"
        exit 0 ;;
    *)
        echo "Unknown option: $MODE" >&2
        echo "Use: (no args) | --facts | --drop   (see --help)" >&2
        exit 1 ;;
esac

cd "$REPO_ROOT/examples/horizon-harvester"
exec node --env-file="$REPO_ROOT/.env" scripts/cleanup-local-db.js
