#!/bin/sh
# Run the patched omp (installed as `cgs`) in a throwaway container: nothing from the host home is mounted, and state lives in a tmpfs
# (gone on exit). Usage: docker/run.sh [cgs args...]    e.g. docker/run.sh        (opens the TUI)
# Env: CGS_BIN (default /tmp/omp-build/packages/coding-agent/dist/cgs, built by docker/build.sh), CGS_BASE_URL (passed through),
#      STATE=<volume> keeps ~/.cgs across runs.
#
# cgs keeps its state in ~/.cgs (PI_CONFIG_DIR) and never touches ~/.omp.
# omp only emits OSC 8 hyperlinks (Ctrl+click, copy link) on terminals it recognises from identity variables
# (TERM_PROGRAM, KITTY_WINDOW_ID, ...), which are forwarded below. VTE terminals (GNOME Terminal, Xfce Terminal) are
# not recognised at all, and a bare `-e TERM` container looks like an unknown one, so links are forced on by default
# (PI_FORCE_HYPERLINKS=1); a terminal without OSC 8 support ignores the sequence. PI_NO_HYPERLINKS=1 on the host wins.
set -e
CGS_BIN=${CGS_BIN:-/tmp/omp-build/packages/coding-agent/dist/cgs}
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
[ -z "${PI_FORCE_HYPERLINKS:-}" ] && [ -z "${PI_NO_HYPERLINKS:-}" ] && TERM_ENV="$TERM_ENV -e PI_FORCE_HYPERLINKS=1"
# shellcheck disable=SC2086
exec docker run --rm -it --network host \
  -v "$CGS_BIN":/usr/local/bin/cgs:ro -v "$ROOT":/cgscli:ro \
  $HOME_MOUNT -e HOME=/home/t -e TERM="${TERM:-xterm-256color}" $TERM_ENV \
  -e PI_CONFIG_DIR=.cgs -e PI_NATIVES_DIR=/home/t/.cgs/natives \
  ${CGS_BASE_URL:+-e CGS_BASE_URL="$CGS_BASE_URL"} \
  -w /tmp --entrypoint sh cgscli-build -c '
    mkdir -p /home/t/.cgs/agent
    PI_CODING_AGENT_DIR=/home/t/.cgs/agent bun /cgscli/scripts/seed-config.ts /cgscli/plugin/omp-extension/index.ts
    exec cgs "$@"' sh "$@"
