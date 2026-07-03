#!/usr/bin/env bash

set -euo pipefail

source /run/pilotswarm/runtime.env

export HOME=/home/pilotswarm
export SHELL=/bin/bash
export USER=pilotswarm
export LOGNAME=pilotswarm

cd /app
exec node packages/app/tui/bin/tui.js local
