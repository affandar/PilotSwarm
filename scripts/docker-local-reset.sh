#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/docker-local-common.sh"

SKIP_CONFIRM=false
for arg in "$@"; do
    case "$arg" in
        --yes|-y)
            SKIP_CONFIRM=true
            ;;
    esac
done

if [[ "${SKIP_CONFIRM}" != "true" ]]; then
    echo "[docker-local] This will stop ${PILOTSWARM_DOCKER_CONTAINER} and delete the Docker volume ${PILOTSWARM_DOCKER_VOLUME}."
    printf "[docker-local] Continue? [y/N] "
    read -r answer
    if [[ "${answer}" != "y" && "${answer}" != "Y" ]]; then
        echo "[docker-local] Aborted."
        exit 0
    fi
fi

if docker_local_container_exists; then
    echo "[docker-local] Removing container ${PILOTSWARM_DOCKER_CONTAINER}..."
    docker rm -f "${PILOTSWARM_DOCKER_CONTAINER}" >/dev/null 2>&1 || true
else
    echo "[docker-local] Container ${PILOTSWARM_DOCKER_CONTAINER} is already absent."
fi

if docker volume inspect "${PILOTSWARM_DOCKER_VOLUME}" >/dev/null 2>&1; then
    echo "[docker-local] Removing volume ${PILOTSWARM_DOCKER_VOLUME}..."
    docker volume rm "${PILOTSWARM_DOCKER_VOLUME}" >/dev/null
    echo "[docker-local] Volume removed."
else
    echo "[docker-local] Volume ${PILOTSWARM_DOCKER_VOLUME} does not exist."
fi

echo "[docker-local] Reset complete."
