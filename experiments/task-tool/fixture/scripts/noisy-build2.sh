#!/bin/bash
# Fake build: checksum computed at runtime, so it cannot be read from source.
cd "$(dirname "$0")/.."
for i in $(seq 1 200); do echo "compiling unit $i of 500 ... ok (cache miss, 12ms)"; done
echo "linker: resolving 4812 symbols across 37 archives"
for i in $(seq 201 380); do echo "compiling unit $i of 500 ... ok (cache hit, 1ms)"; done
echo "CHECKSUM: $(cat src/*.js | shasum -a 256 | cut -c1-12)"
for i in $(seq 381 500); do echo "compiling unit $i of 500 ... ok (cache hit, 1ms)"; done
echo "BUILD OK in 41.7s"
