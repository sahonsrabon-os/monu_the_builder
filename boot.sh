#!/usr/bin/env bash
# boot.sh - bring up the local stack with a single command.
#
# Two things have to be running after a reboot and neither starts itself:
#
#   1. ollama                 - model daemon        (port 11434)
#   2. node start.js           - Mission Barisal     (port 5000, plus the
#                              local-llm-bridge 11435 and php-broker 9998
#                              which it spawns itself)
#
# This script is idempotent: anything already listening is left alone, so
# running it twice never starts a second copy or fights over a port. It
# never stops or kills a process - use it to start, not to restart.
#
# Usage:
#   ./boot.sh                 start whatever is missing, then verify
#   ./boot.sh --status        show what is running, change nothing
#   ./boot.sh --with-opencode start the stack, then launch the desktop app
#   ./boot.sh --help          this text
set -uo pipefail

APP_DIR="${HOME}/z/monu_the_builder"
OLLAMA_PORT=11434
GATEWAY_PORT=5000
LOG_DIR="${HOME}/.opencode"
BOOT_LOG="${LOG_DIR}/boot.log"

MODE="start"
LAUNCH_OPENCODE=0

for arg in "$@"; do
  case "$arg" in
    --status)       MODE="status" ;;
    --with-opencode) LAUNCH_OPENCODE=1 ;;
    --help|-h)
      sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown flag: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

# True when something is accepting connections on 127.0.0.1:$1.
listening() {
  ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE ":$1\$"
}

# True when an HTTP answer comes back from 127.0.0.1:$1 within 3 seconds.
answering() {
  curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:$1/" 2>/dev/null
}

# Append one line to the boot log. Best effort: a missing log directory is
# created, and a write failure never aborts the script.
record() {
  mkdir -p "$LOG_DIR" 2>/dev/null || return 0
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$BOOT_LOG" 2>/dev/null || true
}

status_line() {
  local name="$1" port="$2"
  if listening "$port"; then
    printf '  %-18s port %-6s RUNNING\n' "$name" "$port"
  else
    printf '  %-18s port %-6s stopped\n' "$name" "$port"
  fi
}

report() {
  echo "status:"
  status_line "ollama"     "$OLLAMA_PORT"
  status_line "gateway"    "$GATEWAY_PORT"
  # These two are spawned by start.js, so they follow the gateway.
  status_line "llm-bridge" 11435
  status_line "php-broker" 9998
}

start_ollama() {
  if listening "$OLLAMA_PORT"; then
    echo "  ollama already running - left alone"
    return 0
  fi
  if ! command -v ollama >/dev/null 2>&1; then
    echo "  ollama: NOT INSTALLED (command not found)"
    record "boot ollama MISSING binary"
    return 1
  fi
  echo "  starting ollama ..."
  # Detached so this script returns immediately; output goes to the log dir.
  nohup ollama serve >"${LOG_DIR}/ollama.log" 2>&1 &
  disown 2>/dev/null || true
  record "boot ollama started pid=$!"
}

start_gateway() {
  if listening "$GATEWAY_PORT"; then
    echo "  gateway already running - left alone"
    return 0
  fi
  if [ ! -f "${APP_DIR}/start.js" ]; then
    echo "  gateway: start.js NOT FOUND in ${APP_DIR}"
    record "boot gateway MISSING start.js"
    return 1
  fi
  echo "  starting Mission Barisal gateway ..."
  # nohup.out is the existing, gitignored runtime log for start.js.
  ( cd "$APP_DIR" && nohup node start.js --start-all -s >>nohup.out 2>&1 & disown 2>/dev/null || true )
  record "boot gateway started from ${APP_DIR}"
}

wait_for_port() {
  local port="$1" tries="${2:-20}"
  local i=0
  while [ "$i" -lt "$tries" ]; do
    listening "$port" && return 0
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

if [ "$MODE" = "status" ]; then
  report
  exit 0
fi

echo "boot: checking the stack"
start_ollama
start_gateway

echo "verifying:"
if wait_for_port "$OLLAMA_PORT" 20; then
  echo "  ollama     OK   http://127.0.0.1:${OLLAMA_PORT}"
  record "boot verify ollama OK"
else
  echo "  ollama     FAILED - port ${OLLAMA_PORT} did not open (see ${LOG_DIR}/ollama.log)"
  record "boot verify ollama FAILED"
fi

if wait_for_port "$GATEWAY_PORT" 40; then
  echo "  gateway    OK   http://127.0.0.1:${GATEWAY_PORT}"
  if answering "$GATEWAY_PORT"; then
    echo "             HTTP answer received"
  else
    echo "             listening, but no HTTP answer yet"
  fi
  record "boot verify gateway OK"
else
  echo "  gateway    FAILED - port ${GATEWAY_PORT} did not open (see ${APP_DIR}/nohup.out)"
  record "boot verify gateway FAILED"
fi

echo
report

if [ "$LAUNCH_OPENCODE" -eq 1 ]; then
  echo
  echo "launching OpenCode desktop ..."
  for candidate in opencode "opencode-desktop" "${HOME}/.local/bin/opencode"; do
    if command -v "$candidate" >/dev/null 2>&1; then
      nohup "$candidate" >/dev/null 2>&1 &
      disown 2>/dev/null || true
      echo "  started: $(command -v "$candidate")"
      record "boot opencode launched via ${candidate}"
      break
    fi
  done
  if ! command -v opencode >/dev/null 2>&1 && ! command -v opencode-desktop >/dev/null 2>&1; then
    echo "  no opencode command on PATH - launch it from your desktop menu"
    record "boot opencode MISSING command"
  fi
fi
