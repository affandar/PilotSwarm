#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/docker-local-common.sh"

require_github_token

cd "${REPO_ROOT}"

if [[ "${PILOTSWARM_DOCKER_SKIP_BUILD}" != "1" ]]; then
    echo "[docker-local] Building starter image..."
    docker build \
        "${docker_build_platform_args[@]}" \
        -f deploy/Dockerfile.starter \
        -t "${PILOTSWARM_DOCKER_IMAGE}" \
        .
else
    echo "[docker-local] Skipping image build (PILOTSWARM_DOCKER_SKIP_BUILD=1)."
fi

if docker_local_container_exists; then
    echo "[docker-local] Removing existing container ${PILOTSWARM_DOCKER_CONTAINER}..."
    docker rm -f "${PILOTSWARM_DOCKER_CONTAINER}" >/dev/null
fi

run_args=(
    docker run -d
    "${docker_run_platform_args[@]}"
    --name "${PILOTSWARM_DOCKER_CONTAINER}"
    -p "127.0.0.1:${PILOTSWARM_DOCKER_PORTAL_PORT}:3001"
    -p "127.0.0.1:${PILOTSWARM_DOCKER_SSH_PORT}:2222"
    -e "GITHUB_TOKEN=${GITHUB_TOKEN}"
    -v "${PILOTSWARM_DOCKER_VOLUME}:/data"
)

if [[ -n "${DATABASE_URL:-}" ]]; then
    run_args+=(-e "DATABASE_URL=${DATABASE_URL}")
fi
if [[ -n "${AZURE_STORAGE_CONNECTION_STRING:-}" ]]; then
    run_args+=(-e "AZURE_STORAGE_CONNECTION_STRING=${AZURE_STORAGE_CONNECTION_STRING}")
fi
if [[ -n "${AZURE_STORAGE_CONTAINER:-}" ]]; then
    run_args+=(-e "AZURE_STORAGE_CONTAINER=${AZURE_STORAGE_CONTAINER}")
fi
if [[ -f "${PILOTSWARM_DOCKER_AUTHORIZED_KEYS_PATH}" ]]; then
    run_args+=(-v "${PILOTSWARM_DOCKER_AUTHORIZED_KEYS_PATH}:/run/pilotswarm/authorized_keys:ro")
else
    echo "[docker-local] No SSH public key found at ${PILOTSWARM_DOCKER_AUTHORIZED_KEYS_PATH}; browser portal will work, SSH login will be disabled."
fi

run_args+=("${PILOTSWARM_DOCKER_IMAGE}")

container_id="$("${run_args[@]}")"

echo "[docker-local] Started ${PILOTSWARM_DOCKER_CONTAINER} (${container_id:0:12})."
print_docker_local_summary
echo "[docker-local] Logs: docker logs -f ${PILOTSWARM_DOCKER_CONTAINER}"
