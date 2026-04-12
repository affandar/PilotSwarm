#!/usr/bin/env bash

set -euo pipefail

source /run/pilotswarm/runtime.env
/app/deploy/bin/wait-for-db.sh

cd /app
exec node packages/portal/server.js
