#!/usr/bin/env bash

set -euo pipefail

WORKER_NAME=${1:-worker}

source /run/pilotswarm/runtime.env
/app/deploy/bin/wait-for-db.sh

export POD_NAME="${WORKER_NAME}"

cd /app
exec node packages/sdk/examples/worker.js
