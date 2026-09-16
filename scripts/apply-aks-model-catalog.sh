#!/usr/bin/env bash
# Deployment-specific catalog; does not rebuild or change application images.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/deploy/config/pilotswarm-aks"
K=(kubectl --context pilotswarm-aks -n copilot-runtime)
"${K[@]}" create configmap pilotswarm-aks-model-catalog \
  --from-file=model_providers.json="$CONFIG/model_providers.json" \
  --dry-run=client -o yaml | "${K[@]}" apply -f -
if [ "$#" -eq 0 ]; then set -- copilot-runtime-worker pilotswarm-portal pilotswarm-mcp; fi
for name in "$@"; do
    case "$name" in copilot-runtime-worker|pilotswarm-portal|pilotswarm-mcp) ;; *) exit 1 ;; esac
    "${K[@]}" patch deployment "$name" --type=strategic --patch-file "$CONFIG/$name.patch.json"
done
