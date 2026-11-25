#!/bin/sh
# Build the patched omp inside the cgscli-build image (nothing is installed on the host). Usage: docker/build.sh [omp-checkout]
# The checkout (default /tmp/omp-build) must be omp at omp.lock.json's commit with patches/ applied (scripts/replay-patches.ts).
set -e
SRC=${1:-/tmp/omp-build}
run() { docker run --rm -v "$SRC":/src -v cgscli-rustup:/opt/rustup -v cgscli-cargo:/opt/cargo/registry -w "$2" cgscli-build sh -c "$1"; }
run 'rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install --profile minimal $(grep channel rust-toolchain.toml | cut -d\" -f2); bun install --ignore-scripts && bun run build:native' /src
# The binary is renamed to `cgs`; nothing else about omp's branding changes here (that is patch P4).
run 'bun run build && mv dist/omp dist/cgs' /src/packages/coding-agent
echo "built: $SRC/packages/coding-agent/dist/cgs"
