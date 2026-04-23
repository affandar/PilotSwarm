#!/usr/bin/env bash
# DeployApplicationManifest.sh — PilotSwarm EV2 shell extension
#
# Renders the Kustomize overlay at <overlay-path>, bundles the rendered
# manifests, and uploads the bundle to the target manifest storage account
# and container. FluxConfig on the AKS cluster reconciles from that container.
#
# Usage:
#   DeployApplicationManifest.sh \
#     --overlay-path <path-to-kustomize-overlay> \
#     --target-storage <storage-account-name> \
#     --container-name <blob-container-name>
#
# Auth: managed identity via `az login --identity`; storage upload uses
# `--auth-mode login` (requires the MI to have Storage Blob Data Contributor
# on the target account).
set -euo pipefail

OVERLAY_PATH=""
TARGET_STORAGE=""
CONTAINER_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --overlay-path)    OVERLAY_PATH="$2";    shift 2 ;;
    --target-storage)  TARGET_STORAGE="$2";  shift 2 ;;
    --container-name)  CONTAINER_NAME="$2";  shift 2 ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$OVERLAY_PATH" || -z "$TARGET_STORAGE" || -z "$CONTAINER_NAME" ]]; then
  echo "Required: --overlay-path, --target-storage, --container-name" >&2
  exit 2
fi

if [[ ! -d "$OVERLAY_PATH" ]]; then
  echo "Overlay path not found: $OVERLAY_PATH" >&2
  exit 1
fi

echo "Logging in with managed identity"
az login --identity >/dev/null

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl not available in this shell image." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

RENDERED="${TMP_DIR}/manifests.yaml"
echo "Rendering Kustomize: $OVERLAY_PATH → $RENDERED"
kubectl kustomize "$OVERLAY_PATH" > "$RENDERED"

BLOB_NAME="manifests.yaml"
echo "Uploading $RENDERED to ${TARGET_STORAGE}/${CONTAINER_NAME}/${BLOB_NAME}"
az storage blob upload \
  --auth-mode login \
  --account-name "$TARGET_STORAGE" \
  --container-name "$CONTAINER_NAME" \
  --name "$BLOB_NAME" \
  --file "$RENDERED" \
  --overwrite

echo "Manifest upload complete."

# Work-around for log truncation on ACI shell-extension hosts — matches the
# fleet-manager pattern (see Ev2 shell-extension guidance).
echo "Sleeping 120s to flush logs."
sleep 120
