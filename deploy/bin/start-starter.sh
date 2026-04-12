#!/usr/bin/env bash

set -euo pipefail

APP_ROOT=/app
DATA_DIR=${PILOTSWARM_DATA_DIR:-/data}
LOG_DIR=${PILOTSWARM_LOG_DIR:-${DATA_DIR}/logs}
SESSION_STATE_DIR=${SESSION_STATE_DIR:-${DATA_DIR}/session-state}
ARTIFACT_DIR=${ARTIFACT_DIR:-${DATA_DIR}/artifacts}
EXPORT_DIR=${PILOTSWARM_EXPORT_DIR:-${DATA_DIR}/exports}
POSTGRES_DATA_DIR=${PILOTSWARM_POSTGRES_DIR:-${DATA_DIR}/postgres}
RUNTIME_ENV=/run/pilotswarm/runtime.env
SUPERVISOR_TEMPLATE=${APP_ROOT}/deploy/supervisor/supervisord.conf
SUPERVISOR_CONF=/run/pilotswarm/supervisord.conf
PORT=${PORT:-3001}
SSH_PORT=${SSH_PORT:-2222}
DB_WAIT_SECONDS=${PILOTSWARM_DB_WAIT_SECONDS:-90}
MODEL_PROVIDERS_PATH=${PS_MODEL_PROVIDERS_PATH:-/app/config/model_providers.local-docker.json}
AUTHORIZED_KEYS_SOURCE=${AUTHORIZED_KEYS_PATH:-/run/pilotswarm/authorized_keys}
PORTAL_AUTH_PROVIDER=${PORTAL_AUTH_PROVIDER:-none}
SSH_PASSWORD=${PILOTSWARM_SSH_PASSWORD:-pilotswarm}

mkdir -p "${DATA_DIR}" "${LOG_DIR}" "${SESSION_STATE_DIR}" "${ARTIFACT_DIR}" "${EXPORT_DIR}" /run/pilotswarm /run/sshd
touch "${LOG_DIR}/starter.log"

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    echo "[starter] GITHUB_TOKEN is required for the starter appliance." >&2
    exit 1
fi

configure_ssh_access() {
    local target_dir=/home/pilotswarm/.ssh
    local target_file=${target_dir}/authorized_keys
    install -d -m 700 -o pilotswarm -g pilotswarm "${target_dir}"

    echo "pilotswarm:${SSH_PASSWORD}" | chpasswd

    if [[ -n "${PILOTSWARM_SSH_PASSWORD:-}" ]]; then
        echo "[starter] Enabled SSH password login for user pilotswarm from PILOTSWARM_SSH_PASSWORD."
    else
        echo "[starter] Enabled default SSH password login for user pilotswarm (password: pilotswarm)."
    fi

    if [[ -f "${AUTHORIZED_KEYS_SOURCE}" ]]; then
        cp "${AUTHORIZED_KEYS_SOURCE}" "${target_file}"
        chown pilotswarm:pilotswarm "${target_file}"
        chmod 600 "${target_file}"
        echo "[starter] Installed SSH authorized_keys from ${AUTHORIZED_KEYS_SOURCE}; both key-based and password login are available."
    else
        : > "${target_file}"
        chown pilotswarm:pilotswarm "${target_file}"
        chmod 600 "${target_file}"
        echo "[starter] No SSH authorized_keys file found at ${AUTHORIZED_KEYS_SOURCE}; using password login fallback for local SSH access."
    fi
}

write_env() {
    : > "${RUNTIME_ENV}"
    chmod 644 "${RUNTIME_ENV}"
    write_env_var HOME /home/pilotswarm
    write_env_var PORT "${PORT}"
    write_env_var SSH_PORT "${SSH_PORT}"
    write_env_var DATABASE_URL "${DATABASE_URL}"
    write_env_var PORTAL_TUI_MODE local
    write_env_var PORTAL_MODE local
    write_env_var PORTAL_AUTH_PROVIDER "${PORTAL_AUTH_PROVIDER}"
    write_env_var WORKERS 0
    write_env_var GITHUB_TOKEN "${GITHUB_TOKEN}"
    write_env_var SESSION_STATE_DIR "${SESSION_STATE_DIR}"
    write_env_var ARTIFACT_DIR "${ARTIFACT_DIR}"
    write_env_var PILOTSWARM_EXPORT_DIR "${EXPORT_DIR}"
    write_env_var PILOTSWARM_LOG_DIR "${LOG_DIR}"
    write_env_var PILOTSWARM_DB_WAIT_SECONDS "${DB_WAIT_SECONDS}"
    write_env_var PS_MODEL_PROVIDERS_PATH "${MODEL_PROVIDERS_PATH}"
    if [[ -n "${AZURE_STORAGE_CONNECTION_STRING:-}" ]]; then
        write_env_var AZURE_STORAGE_CONNECTION_STRING "${AZURE_STORAGE_CONNECTION_STRING}"
    fi
    if [[ -n "${AZURE_STORAGE_CONTAINER:-}" ]]; then
        write_env_var AZURE_STORAGE_CONTAINER "${AZURE_STORAGE_CONTAINER}"
    fi
    if [[ -n "${PLUGIN_DIRS:-}" ]]; then
        write_env_var PLUGIN_DIRS "${PLUGIN_DIRS}"
    fi
}

write_env_var() {
    local key=$1
    local value=${2-}
    printf 'export %s=%q\n' "${key}" "${value}" >> "${RUNTIME_ENV}"
}

configure_database() {
    if [[ -n "${DATABASE_URL:-}" ]]; then
        EMBEDDED_POSTGRES=0
        echo "[starter] Using external DATABASE_URL"
        return
    fi

    EMBEDDED_POSTGRES=1
    export DATABASE_URL="postgresql://pilotswarm@127.0.0.1:5432/postgres"
    echo "[starter] No DATABASE_URL provided; enabling embedded PostgreSQL at ${POSTGRES_DATA_DIR}"
}

render_supervisor_config() {
    local postgres_block=""
    if [[ "${EMBEDDED_POSTGRES}" == "1" ]]; then
        postgres_block=$(cat <<'EOF'
[program:postgres]
command=/app/deploy/bin/start-embedded-postgres.sh
directory=/app
user=postgres
autostart=true
autorestart=true
startsecs=3
stopsignal=INT
stdout_logfile=/data/logs/postgres.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=5
redirect_stderr=true
priority=10

EOF
)
    fi

    python3 - "$SUPERVISOR_TEMPLATE" "$SUPERVISOR_CONF" "$postgres_block" <<'PY'
import pathlib
import sys

template_path = pathlib.Path(sys.argv[1])
output_path = pathlib.Path(sys.argv[2])
postgres_block = sys.argv[3]
template = template_path.read_text()
output_path.write_text(template.replace("__POSTGRES_PROGRAM__", postgres_block))
PY
}

prepare_directories() {
    install -d -m 755 -o pilotswarm -g pilotswarm "${LOG_DIR}" "${SESSION_STATE_DIR}" "${ARTIFACT_DIR}" "${EXPORT_DIR}"
    if [[ "${EMBEDDED_POSTGRES}" == "1" ]]; then
        install -d -m 700 -o postgres -g postgres "${POSTGRES_DATA_DIR}"
    fi
}

main() {
    configure_database
    prepare_directories
    configure_ssh_access
    ssh-keygen -A
    write_env
    render_supervisor_config

    echo "[starter] Portal: http://localhost:${PORT}"
    if [[ -n "${PILOTSWARM_SSH_PASSWORD:-}" ]]; then
        echo "[starter] SSH TUI: ssh -p ${SSH_PORT} pilotswarm@localhost (password from PILOTSWARM_SSH_PASSWORD)"
    else
        echo "[starter] SSH TUI: ssh -p ${SSH_PORT} pilotswarm@localhost (default password: pilotswarm)"
    fi
    echo "[starter] Logs: ${LOG_DIR}"
    exec /usr/bin/supervisord -n -c "${SUPERVISOR_CONF}"
}

main "$@"
