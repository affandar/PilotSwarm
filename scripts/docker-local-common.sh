#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PILOTSWARM_DOCKER_ENV_FILE="${PILOTSWARM_DOCKER_ENV_FILE:-${REPO_ROOT}/.env.local.docker}"
if [[ -f "${PILOTSWARM_DOCKER_ENV_FILE}" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "${PILOTSWARM_DOCKER_ENV_FILE}"
    set +a
fi

PILOTSWARM_DOCKER_IMAGE="${PILOTSWARM_DOCKER_IMAGE:-pilotswarm-starter:local}"
PILOTSWARM_DOCKER_CONTAINER="${PILOTSWARM_DOCKER_CONTAINER:-pilotswarm-starter-local}"
PILOTSWARM_DOCKER_VOLUME="${PILOTSWARM_DOCKER_VOLUME:-pilotswarm-starter-local-data}"
PILOTSWARM_DOCKER_PORTAL_PORT="${PILOTSWARM_DOCKER_PORTAL_PORT:-3001}"
PILOTSWARM_DOCKER_SSH_PORT="${PILOTSWARM_DOCKER_SSH_PORT:-2222}"
PILOTSWARM_DOCKER_AUTHORIZED_KEYS_PATH="${PILOTSWARM_DOCKER_AUTHORIZED_KEYS_PATH:-${HOME}/.ssh/id_ed25519.pub}"
PILOTSWARM_DOCKER_SKIP_BUILD="${PILOTSWARM_DOCKER_SKIP_BUILD:-0}"
PILOTSWARM_DOCKER_PLATFORM="${PILOTSWARM_DOCKER_PLATFORM:-}"

if [[ -z "${PILOTSWARM_DOCKER_PLATFORM}" ]]; then
    host_os="$(uname -s)"
    host_arch="$(uname -m)"
    if [[ "${host_os}" == "Darwin" && "${host_arch}" == "arm64" ]]; then
        PILOTSWARM_DOCKER_PLATFORM="linux/amd64"
    fi
fi

docker_build_platform_args=()
docker_run_platform_args=()
if [[ -n "${PILOTSWARM_DOCKER_PLATFORM}" ]]; then
    docker_build_platform_args+=(--platform "${PILOTSWARM_DOCKER_PLATFORM}")
    docker_run_platform_args+=(--platform "${PILOTSWARM_DOCKER_PLATFORM}")
fi

docker_local_container_exists() {
    docker ps -a --format '{{.Names}}' | grep -Fxq "${PILOTSWARM_DOCKER_CONTAINER}"
}

docker_local_container_running() {
    docker ps --format '{{.Names}}' | grep -Fxq "${PILOTSWARM_DOCKER_CONTAINER}"
}

require_github_token() {
    if [[ -z "${GITHUB_TOKEN:-}" ]]; then
        echo "[docker-local] GITHUB_TOKEN is required. Set it in ${PILOTSWARM_DOCKER_ENV_FILE}." >&2
        exit 1
    fi
}

print_docker_local_summary() {
    echo "[docker-local] image: ${PILOTSWARM_DOCKER_IMAGE}"
    echo "[docker-local] container: ${PILOTSWARM_DOCKER_CONTAINER}"
    echo "[docker-local] volume: ${PILOTSWARM_DOCKER_VOLUME}"
    if [[ -n "${PILOTSWARM_DOCKER_PLATFORM}" ]]; then
        echo "[docker-local] platform: ${PILOTSWARM_DOCKER_PLATFORM}"
    fi
    echo "[docker-local] portal: http://127.0.0.1:${PILOTSWARM_DOCKER_PORTAL_PORT}"
    echo "[docker-local] ssh: ssh -p ${PILOTSWARM_DOCKER_SSH_PORT} pilotswarm@127.0.0.1"
}
