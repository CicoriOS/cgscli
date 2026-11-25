#!/bin/sh
# Run the patched omp in a throwaway container: nothing from the host home is mounted, and state lives in a tmpfs
# (gone on exit). Usage: docker/run.sh [omp args...]    e.g. docker/run.sh        (opens the TUI)
# Env: OMP_BIN (default /tmp/omp-build/packages/coding-agent/dist/omp), CGS_BASE_URL (passed through),
#      STATE=<volume> keeps ~/.cgs across runs.
#
# cgs keeps its state in ~/.cgs (PI_CONFIG_DIR) and never touches ~/.omp.
# The terminal's identity variables are forwarded: omp only emits OSC 8 hyperlinks (Ctrl+click, copy link) on terminals
# it recognises from them (TERM_PROGRAM, KITTY_WINDOW_ID, ...). Without them it falls back to a plain true-colour
# profile with no hyperlinks, which is what a bare `-e TERM` container looks like. VTE terminals (GNOME Terminal,
# Xfce Terminal) are not recognised at all: set PI_FORCE_HYPERLINKS=1 on the host to turn links on (passed through).
set -e
OMP_BIN=${OMP_BIN:-/tmp/omp-build/packages/coding-agent/dist/omp}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOME_MOUNT=${STATE:+-v $STATE:/home/t}
[ -z "$HOME_MOUNT" ] && HOME_MOUNT="--tmpfs /home/t:exec,mode=1777"
TERM_ENV=""
for v in TERM_PROGRAM TERM_PROGRAM_VERSION LC_TERMINAL KITTY_WINDOW_ID GHOSTTY_RESOURCES_DIR WEZTERM_PANE ITERM_SESSION_ID \
         VSCODE_PID ALACRITTY_WINDOW_ID WT_SESSION VTE_VERSION KONSOLE_VERSION TERM_FEATURES COLORTERM \
         PI_FORCE_HYPERLINKS PI_NO_HYPERLINKS; do
  eval "val=\${$v:-}"
  [ -n "$val" ] && TERM_ENV="$TERM_ENV -e $v=$val"
done
# shellcheck disable=SC2086
exec docker run --rm -it --network host \
  -v "$OMP_BIN":/usr/local/bin/omp:ro -v "$ROOT":/cgscli:ro \
  $HOME_MOUNT -e HOME=/home/t -e TERM="${TERM:-xterm-256color}" $TERM_ENV \
  -e PI_CONFIG_DIR=.cgs -e PI_NATIVES_DIR=/home/t/.cgs/natives \
  ${CGS_BASE_URL:+-e CGS_BASE_URL="$CGS_BASE_URL"} \
  -w /tmp --entrypoint sh cgscli-build -c '
    mkdir -p /home/t/.cgs/agent
    [ -f /home/t/.cgs/agent/config.yml ] || printf "extensions:\n  - /cgscli/plugin/omp-extension/index.ts\n" > /home/t/.cgs/agent/config.yml
    exec omp "$@"' sh "$@"
