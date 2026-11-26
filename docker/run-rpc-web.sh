#!/bin/sh
# Run the patched omp headless (--mode rpc-ui) in the throwaway container and show its raw RPC frames in a web page (tools/rpc-web).
# Usage: docker/run-rpc-web.sh [cgs args...]     then open http://127.0.0.1:${PORT:-8787}
# Env: as docker/run.sh (CGS_BIN, CGS_BASE_URL, STATE=<volume> keeps ~/.cgs, e.g. the one you logged in with), plus PORT, HOST.
# The container uses the host network; HOST defaults to loopback. Anyone who reaches the port controls the agent.
set -e
CGS_BIN=${CGS_BIN:-/tmp/omp-build/packages/coding-agent/dist/cgs}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOME_MOUNT=${STATE:+-v $STATE:/home/t}
[ -z "$HOME_MOUNT" ] && HOME_MOUNT="--tmpfs /home/t:exec,mode=1777"
# shellcheck disable=SC2086
exec docker run --rm --network host \
  -v "$CGS_BIN":/usr/local/bin/cgs:ro -v "$ROOT":/cgscli:ro \
  $HOME_MOUNT -e HOME=/home/t \
  -e PI_CONFIG_DIR=.cgs -e PI_NATIVES_DIR=/home/t/.cgs/natives \
  ${CGS_BASE_URL:+-e CGS_BASE_URL="$CGS_BASE_URL"} ${PORT:+-e PORT="$PORT"} ${HOST:+-e HOST="$HOST"} \
  -w /tmp --entrypoint sh cgscli-build -c '
    mkdir -p /home/t/.cgs/agent
    PI_CODING_AGENT_DIR=/home/t/.cgs/agent bun /cgscli/scripts/seed-config.ts /cgscli/plugin/omp-extension/index.ts
    exec bun /cgscli/tools/rpc-web/server.ts -- cgs --mode rpc-ui "$@"' sh "$@"
