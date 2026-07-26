#!/usr/bin/env bash
# Stop the services started by start.sh (detached or not). Safe to run twice.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

STUDIO_PORT=5050
stopped=0

# Studio first, then ComfyUI, then Ollama: the studio is the only one exposed,
# so it should stop accepting work before its dependencies disappear.
for name in studio comfyui ollama; do
  pidfile="$LOG_DIR/$name.pid"
  [ -f "$pidfile" ] || continue
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    # The supervisor loop dies first, or it would just restart the service we
    # are about to kill.
    kill "$pid" 2>/dev/null || true
    pkill -P "$pid" 2>/dev/null || true
    log "stopped $name (supervisor pid $pid)"
    stopped=$((stopped + 1))
  else
    log "$name was not running"
  fi
  rm -f "$pidfile"
done

if [ "$stopped" -eq 0 ]; then
  log "nothing was running"
fi

# Report honestly rather than assume the kills landed.
if wait_http "http://127.0.0.1:$STUDIO_PORT/api/health" 1 2>/dev/null; then
  warn "something is STILL answering on port $STUDIO_PORT."
  warn "A studio started outside start.sh keeps no pid file here; find it with:"
  warn "  ps -ef | grep -e backend/run.py -e ComfyUI/main.py -e 'ollama serve'"
  exit 1
fi
log "all stopped"
