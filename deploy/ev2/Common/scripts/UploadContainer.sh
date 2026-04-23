#!/usr/bin/env bash
# UploadContainer.sh — PilotSwarm EV2 shell extension
#
# Copies a container image into the per-region ACR owned by this stamp.
#
# Two supported modes:
#   1. Cross-ACR import (preferred, no local docker required):
#        --source-acr <source>.azurecr.io --target-acr <target>.azurecr.io \
#        --image-name <name> --image-tag <tag>
#      Uses `az acr import` to copy <source>/<image>:<tag> → <target>/<image>:<tag>.
#
#   2. Local tarball load & push (fallback; requires docker runtime):
#        --source-tarball <path> --target-acr <target>.azurecr.io \
#        --image-name <name> --image-tag <tag>
#      Uses `docker load` + `docker tag` + `docker push` into the target ACR.
#
# Authentication is via managed identity (`az login --identity`) during EV2
# shell-extension execution.
set -euo pipefail

SOURCE_ACR=""
SOURCE_TARBALL=""
TARGET_ACR=""
IMAGE_NAME=""
IMAGE_TAG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-acr)      SOURCE_ACR="$2";      shift 2 ;;
    --source-tarball)  SOURCE_TARBALL="$2";  shift 2 ;;
    --target-acr)      TARGET_ACR="$2";      shift 2 ;;
    --image-name)      IMAGE_NAME="$2";      shift 2 ;;
    --image-tag)       IMAGE_TAG="$2";       shift 2 ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$TARGET_ACR" || -z "$IMAGE_NAME" || -z "$IMAGE_TAG" ]]; then
  echo "Required: --target-acr, --image-name, --image-tag" >&2
  exit 2
fi

if [[ -z "$SOURCE_ACR" && -z "$SOURCE_TARBALL" ]]; then
  echo "Required: either --source-acr or --source-tarball" >&2
  exit 2
fi

echo "Logging in with managed identity"
az login --identity >/dev/null

# Strip any .azurecr.io suffix the caller passed to get the bare ACR name for az.
target_acr_name="${TARGET_ACR%%.azurecr.io}"

if [[ -n "$SOURCE_ACR" ]]; then
  source_acr_name="${SOURCE_ACR%%.azurecr.io}"
  source_ref="${source_acr_name}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}"
  echo "Importing ${source_ref} → ${target_acr_name}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}"
  az acr import \
    --name "$target_acr_name" \
    --source "$source_ref" \
    --image "${IMAGE_NAME}:${IMAGE_TAG}" \
    --force
  echo "Image imported successfully."
  exit 0
fi

# Fallback path: docker load + tag + push.
if [[ ! -f "$SOURCE_TARBALL" ]]; then
  echo "Source tarball not found: $SOURCE_TARBALL" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not available in this shell image; use --source-acr instead." >&2
  exit 1
fi

echo "Loading image from tarball: $SOURCE_TARBALL"
loaded_ref="$(docker load -i "$SOURCE_TARBALL" | awk -F': ' '/Loaded image/ {print $2; exit}')"
if [[ -z "$loaded_ref" ]]; then
  echo "Failed to parse image reference from 'docker load' output." >&2
  exit 1
fi

target_ref="${target_acr_name}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}"
echo "Tagging ${loaded_ref} → ${target_ref}"
docker tag "$loaded_ref" "$target_ref"

echo "Logging in to ACR ${target_acr_name}"
az acr login --name "$target_acr_name"

echo "Pushing ${target_ref}"
docker push "$target_ref"
echo "Image pushed successfully."
