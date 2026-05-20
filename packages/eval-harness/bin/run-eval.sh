#!/usr/bin/env bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  SOURCE_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  TARGET="$(readlink "$SOURCE")"
  if [[ "$TARGET" == /* ]]; then
    SOURCE="$TARGET"
  else
    SOURCE="$SOURCE_DIR/$TARGET"
  fi
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
DIST_ENTRY="$SCRIPT_DIR/../dist/bin/run-eval.js"
SOURCE_ENTRY="$SCRIPT_DIR/run-eval.ts"
NEWER_SOURCE=""
if [ -f "$DIST_ENTRY" ]; then
  NEWER_SOURCE="$(
    find "$SCRIPT_DIR/.." \
      \( -path "$SCRIPT_DIR/../dist" -o -path "$SCRIPT_DIR/../node_modules" \) -prune \
      -o -type f \
      \( -path "$SCRIPT_DIR/../src/*" -o -path "$SCRIPT_DIR/*" -o -path "$SCRIPT_DIR/../package.json" \) \
      -newer "$DIST_ENTRY" -print -quit
  )"
fi
if [ -f "$DIST_ENTRY" ] && [ -z "$NEWER_SOURCE" ]; then
  node "$DIST_ENTRY" "$@"
else
  node --no-warnings --experimental-strip-types --loader "$SCRIPT_DIR/ts-loader.mjs" "$SOURCE_ENTRY" "$@"
fi
