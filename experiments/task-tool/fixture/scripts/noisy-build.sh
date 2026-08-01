#!/bin/bash
# Fake build: lots of noise, one interesting value buried in the middle.
for i in $(seq 1 180); do echo "compiling unit $i of 500 ... ok (cache miss, 12ms)"; done
echo "linker: resolving 4812 symbols across 37 archives"
for i in $(seq 181 340); do echo "compiling unit $i of 500 ... ok (cache hit, 1ms)"; done
echo "CHECKSUM: 7f3a9c-e51b22"
for i in $(seq 341 500); do echo "compiling unit $i of 500 ... ok (cache hit, 1ms)"; done
echo "packaging artifacts: 14 files, 3.2 MB"
echo "BUILD OK in 41.7s"
