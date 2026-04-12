#!/usr/bin/env bash

set -euo pipefail

if [[ -f /run/pilotswarm/runtime.env ]]; then
    # shellcheck disable=SC1091
    source /run/pilotswarm/runtime.env
fi

PGDATA=${PILOTSWARM_POSTGRES_DIR:-/data/postgres}
PGPORT=${PILOTSWARM_PG_PORT:-5432}
PGHOST=127.0.0.1

find_pg_bin_dir() {
    find /usr/lib/postgresql -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1
}

PG_BIN_DIR=$(find_pg_bin_dir)/bin
export PATH="${PG_BIN_DIR}:${PATH}"

mkdir -p "${PGDATA}"

if [[ ! -f "${PGDATA}/PG_VERSION" ]]; then
    initdb -D "${PGDATA}" --username=pilotswarm --auth=trust --encoding=UTF8 --locale=C
    cat >> "${PGDATA}/postgresql.conf" <<EOF
listen_addresses = '127.0.0.1'
port = ${PGPORT}
max_connections = 100
shared_buffers = 128MB
fsync = on
synchronous_commit = on
EOF
    cat > "${PGDATA}/pg_hba.conf" <<'EOF'
local   all             all                                     trust
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust
EOF
fi

exec postgres -D "${PGDATA}" -p "${PGPORT}" -h "${PGHOST}"
