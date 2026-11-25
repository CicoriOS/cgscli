#!/bin/sh
# Run the patched omp in a throwaway container: nothing from the host home is mounted, and state lives in a tmpfs
# (gone on exit). Usage: docker/run.sh [omp args...]    e.g. docker/run.sh        (opens the TUI)
# Env: OMP_BIN (default /tmp/omp-build/packages/coding-agent/dist/omp), CGS_BASE_URL (passed through),
#      STATE=<volume> keeps ~/.omp across runs.
set -e
OMP_BIN=${OMP_BIN:-/tmp/omp-build/packages/coding-agent/dist/omp}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOME_MOUNT=${STATE:+-v $STATE:/home/t}
[ -z "$HOME_MOUNT" ] && HOME_MOUNT="--tmpfs /home/t:exec,mode=1777"
exec docker run --rm -it --network host \
  -v "$OMP_BIN":/usr/local/bin/omp:ro -v "$ROOT":/cgscli:ro \
  $HOME_MOUNT -e HOME=/home/t -e TERM="${TERM:-xterm-256color}" -e COLORTERM=truecolor \
  ${CGS_BASE_URL:+-e CGS_BASE_URL="$CGS_BASE_URL"} \
  -w /tmp --entrypoint sh cgscli-build -c '
    mkdir -p /home/t/.omp/agent
    [ -f /home/t/.omp/agent/config.yml ] || printf "extensions:\n  - /cgscli/plugin/omp-extension/index.ts\n" > /home/t/.omp/agent/config.yml
    exec omp "$@"' sh "$@"
