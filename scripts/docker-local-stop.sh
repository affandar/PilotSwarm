#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/docker-local-common.sh"

if docker_local_container_exists; then
    echo "[docker-local] Stopping ${PILOTSWARM_DOCKER_CONTAINER}..."
    docker rm -f "${PILOTSWARM_DOCKER_CONTAINER}" >/dev/null 2>&1 || true
    echo "[docker-local] Stop requested for ${PILOTSWARM_DOCKER_CONTAINER}."
else
    echo "[docker-local] Container ${PILOTSWARM_DOCKER_CONTAINER} is not running."
fi
