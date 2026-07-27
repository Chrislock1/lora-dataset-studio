#!/usr/bin/env bash
# Every-boot supervisor: Ollama -> ComfyUI -> studio, each health-checked before
# the next starts, all kept alive afterwards. Set this as the pod's start
# command so a restart comes back by itself, or run it by hand after setup.sh.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

# The one port RunPod proxies. Everything else stays on loopback.
STUDIO_PORT=5050

[ -f "$MARKER_DIR/seed_config.done" ] \
  || die "setup has not completed - run $SCRIPT_DIR/setup.sh first"
mkdir -p "$LOG_DIR"

# LDS_DATA_DIR alone is NOT enough: config.py resolves config.json from
# LDS_CONFIG and .env from LDS_ENV, each falling back to the REPO root rather
# than to the data dir. Without these two the app would silently read no config
# at all -- which means require_token back to its default of false, and a pod
# open to anyone who can guess the proxy URL. (The Dockerfile pins LDS_CONFIG
# for the same reason.)
export LDS_DATA_DIR="$DATA_DIR"
export LDS_CONFIG="$DATA_DIR/config.json"
export LDS_ENV="$DATA_DIR/.env"

# --- Access token: mandatory, and it takes BOTH halves.
# server.require_token in config.json is what makes backend/app/netguard.py
# check anything at all; this variable supplies the value it checks against.
# RunPod proxy URLs are derivable from the pod id, so a bind without the gate
# would hand the internet the datasets, the API keys and the GPU.
if ! grep -q '"require_token"[[:space:]]*:[[:space:]]*true' "$LDS_CONFIG"; then
  die "config.json does not set server.require_token=true - the token gate would
be inert and this pod is reachable at a guessable public URL. Fix config.json
(or delete it and re-run setup.sh) before starting."
fi

TOKEN_FILE="$DATA_DIR/.access-token"
if [ -n "${LDS_ACCESS_TOKEN:-}" ]; then
  printf '%s' "$LDS_ACCESS_TOKEN" > "$TOKEN_FILE"
elif [ ! -s "$TOKEN_FILE" ]; then
  python3 -c 'import secrets; print(secrets.token_urlsafe(24), end="")' > "$TOKEN_FILE"
  log "generated a new access token (delete $TOKEN_FILE to rotate it)"
fi
chmod 600 "$TOKEN_FILE"
LDS_ACCESS_TOKEN="$(cat "$TOKEN_FILE")"
export LDS_ACCESS_TOKEN

# --- Detached mode: survive the terminal closing.
# A web terminal that disconnects sends SIGHUP to its foreground process group,
# which otherwise takes all three services down with it. Everything above this
# point runs in the foreground on purpose, so a bad config or a missing setup
# still reports itself where you can see it; only the long-running part detaches.
if [ "${1:-}" = "--detach" ] && [ -z "${LDS_DETACHED:-}" ]; then
  if wait_http "http://127.0.0.1:$STUDIO_PORT/api/health" 1 2>/dev/null; then
    die "the studio is already answering on port $STUDIO_PORT - stop it before starting another"
  fi
  # setsid detaches into a new session with no controlling terminal, so SIGHUP
  # is never delivered at all; nohup alone only ignores it.
  launcher="setsid"
  command -v setsid >/dev/null 2>&1 || launcher="nohup"
  LDS_DETACHED=1 $launcher bash "$SCRIPT_DIR/start.sh" \
    >> "$LOG_DIR/start.log" 2>&1 < /dev/null &
  disown 2>/dev/null || true
  log "starting in the background - full log: $LOG_DIR/start.log"
  if wait_http "http://127.0.0.1:$STUDIO_PORT/api/health" 600; then
    POD_ID="${RUNPOD_POD_ID:-<pod-id>}"
    log "--------------------------------------------------------"
    log "LoRA Dataset Studio is up and will survive this terminal closing."
    log "Open:  https://${POD_ID}-${STUDIO_PORT}.proxy.runpod.net/?token=${LDS_ACCESS_TOKEN}"
    log "Stop:  $SCRIPT_DIR/stop.sh"
    log "--------------------------------------------------------"
  else
    warn "not answering yet after 600s - it may still be loading models."
    warn "Watch it with: tail -f $LOG_DIR/start.log"
  fi
  exit 0
fi

# Supervisor subshell PIDs, so a failed start tears its siblings down instead of
# orphaning them on 11434/8188 where the next run collides with them.
SUPERVISOR_PIDS=()
cleanup_supervisors() {
  local pid
  for pid in ${SUPERVISOR_PIDS[@]+"${SUPERVISOR_PIDS[@]}"}; do
    kill "$pid" 2>/dev/null || true        # stop the restart loop first...
    pkill -P "$pid" 2>/dev/null || true    # ...then whatever it spawned
  done
}
# INT/TERM as well as EXIT: a pod stop or a Ctrl-C sends a signal, and a bash
# that dies on an uncaught one never runs its EXIT trap.
trap cleanup_supervisors EXIT INT TERM

# supervise <name> <health_url> <cmd...>: run <cmd> under a restart loop with
# backoff, then block until its health URL answers. A crash restarts only that
# service; the others keep running.
supervise() {
  local name="$1" health="$2"
  shift 2
  (
    local backoff=5
    while true; do
      if "$@" >> "$LOG_DIR/$name.log" 2>&1; then
        backoff=5
      fi
      echo "[supervisor] $name exited - restarting in ${backoff}s" >> "$LOG_DIR/$name.log"
      sleep "$backoff"
      if [ "$backoff" -lt 60 ]; then
        backoff=$((backoff * 2))
      fi
    done
  ) &
  SUPERVISOR_PIDS+=("$!")
  echo "$!" > "$LOG_DIR/$name.pid"
  if ! wait_http "$health" 180; then
    warn "$name is not answering on $health after 180s. Last lines of its log:"
    tail -20 "$LOG_DIR/$name.log" >&2 || true
    warn "Full log: $LOG_DIR/$name.log"
    return 1
  fi
  log "$name is up"
}

# Fail fast on a fresh container disk. /workspace survives a new pod, but apt
# packages and Ollama's /usr/local binary do not - and the completion markers for
# those used to live on the volume, so setup would report "already done" while
# the binaries were gone. Without this check the first casualty is a 180s health
# timeout that blames the service instead of naming the cause.
missing=""
command -v ollama >/dev/null 2>&1 || missing="$missing ollama"
[ -x "$COMFY_DIR/venv/bin/python" ] || missing="$missing ComfyUI's venv"
[ -x "$LDS_DIR/.venv/bin/python" ] || missing="$missing the studio's venv"
if [ -n "$missing" ]; then
  warn "missing on this pod:$missing"
  warn "The network volume is intact, but this container's disk is fresh, so"
  warn "anything installed outside /workspace (apt packages, Ollama's binary in"
  warn "/usr/local) is gone with the previous pod."
  die "Re-run $SCRIPT_DIR/setup.sh - it reinstalls only those, and keeps the models."
fi

export OLLAMA_MODELS="$OLLAMA_MODELS_DIR"
export OLLAMA_HOST="127.0.0.1:11434"
supervise ollama "http://127.0.0.1:11434" ollama serve

supervise comfyui "http://127.0.0.1:8188/system_stats" \
  "$COMFY_DIR/venv/bin/python" "$COMFY_DIR/main.py" --listen 127.0.0.1 --port 8188

export LDS_HOST="0.0.0.0" LDS_PORT="$STUDIO_PORT"
supervise studio "http://127.0.0.1:$STUDIO_PORT/api/health" \
  bash -c "cd '$LDS_DIR' && exec .venv/bin/python backend/run.py"

POD_ID="${RUNPOD_POD_ID:-<pod-id>}"
log "--------------------------------------------------------"
log "LoRA Dataset Studio is up."
log "Open:  https://${POD_ID}-${STUDIO_PORT}.proxy.runpod.net/?token=${LDS_ACCESS_TOKEN}"
log "Logs:  $LOG_DIR/{ollama,comfyui,studio}.log"
log ""
log "If that URL hangs or 404s while the studio is up here, port $STUDIO_PORT is not"
log "exposed on this pod. RunPod only proxies ports declared when the pod is"
log "created - nothing inside the container can detect or change that."
log "--------------------------------------------------------"

# A RunPod start command must not exit, or the pod is torn down.
wait
