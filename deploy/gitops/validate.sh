#!/usr/bin/env bash
# Validates every GitOps overlay by running `kubectl kustomize` and,
# when available, `kubeconform` (strict schema validation).
#
# Per Spec FR-010 kubeconform is OPTIONAL (a dev convenience) — absence
# is not a hard failure. `kubectl kustomize` failure IS a hard failure.
#
# Usage:
#   deploy/gitops/validate.sh
#
# Exits 0 when every overlay builds; non-zero on first build failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The portal base/kustomization.yaml references model_providers.json via
# configMapGenerator, but that file is not checked in under
# deploy/gitops/portal/base/ — the canonical source lives under the worker
# tree, and stage-manifests.mjs copies it across at deploy time. To keep
# this validator self-contained we stage the same file here before
# running kustomize, then remove it on exit so the working tree stays
# clean.
PORTAL_BASE_MODEL_PROVIDERS="${SCRIPT_DIR}/portal/base/model_providers.json"
WORKER_BASE_MODEL_PROVIDERS="${SCRIPT_DIR}/worker/base/model_providers.json"
staged_portal_model_providers=0

cleanup() {
  if [[ "${staged_portal_model_providers}" -eq 1 ]]; then
    rm -f "${PORTAL_BASE_MODEL_PROVIDERS}"
  fi
}
trap cleanup EXIT

if [[ ! -f "${PORTAL_BASE_MODEL_PROVIDERS}" ]]; then
  if [[ ! -f "${WORKER_BASE_MODEL_PROVIDERS}" ]]; then
    echo "[validate] missing ${WORKER_BASE_MODEL_PROVIDERS}; cannot stage portal model_providers.json." >&2
    exit 1
  fi
  cp "${WORKER_BASE_MODEL_PROVIDERS}" "${PORTAL_BASE_MODEL_PROVIDERS}"
  staged_portal_model_providers=1
fi

OVERLAYS=(
  "${SCRIPT_DIR}/worker/overlays/default"
  "${SCRIPT_DIR}/cert-manager/overlays/default"
  "${SCRIPT_DIR}/cert-manager-issuers/overlays/default"
  "${SCRIPT_DIR}/portal/overlays/afd-letsencrypt"
  "${SCRIPT_DIR}/portal/overlays/afd-akv"
  "${SCRIPT_DIR}/portal/overlays/private-akv"
)

have_kubeconform=0
if command -v kubeconform >/dev/null 2>&1; then
  have_kubeconform=1
else
  echo "[validate] kubeconform not installed — skipping schema validation (optional per FR-010)." >&2
fi

fail=0
for overlay in "${OVERLAYS[@]}"; do
  echo "[validate] building: ${overlay}"
  if ! rendered=$(kubectl kustomize "${overlay}" 2>&1); then
    echo "[validate] FAIL  kubectl kustomize ${overlay}" >&2
    echo "${rendered}" >&2
    fail=1
    continue
  fi

  if [[ "${have_kubeconform}" -eq 1 ]]; then
    if ! printf '%s\n' "${rendered}" | kubeconform -summary -strict -ignore-missing-schemas -; then
      echo "[validate] FAIL  kubeconform ${overlay}" >&2
      fail=1
      continue
    fi
  fi

  echo "[validate] ok    ${overlay}"
done

if [[ "${fail}" -ne 0 ]]; then
  echo "[validate] One or more overlays failed." >&2
  exit 1
fi

echo "[validate] All overlays built successfully."
