#!/usr/bin/env bash
# Shared helpers for the RunPod deploy scripts. Source this; do not execute.
# Everything durable lives under /workspace (the RunPod network volume) so it
# survives pod stop/restart and pod re-creation on the same volume.

WORKSPACE="${WORKSPACE:-/workspace}"
MARKER_DIR="$WORKSPACE/.lds-setup"
DATA_DIR="$WORKSPACE/lds-data"
LOG_DIR="$DATA_DIR/logs"
COMFY_DIR="$WORKSPACE/ComfyUI"
AIT_DIR="$WORKSPACE/ai-toolkit"
LDS_DIR="$WORKSPACE/lora-dataset-studio"
OLLAMA_MODELS_DIR="$WORKSPACE/ollama"

log()  { printf '\033[1;36m[lds]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[lds] WARNING:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[lds] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# run_step <name> <fn>: skip when the step's marker exists; run <fn> and write
# the marker on success. A failed step names itself and how to retry, then dies.
run_step() {
  local name="$1" fn="$2"
  if [ -f "$MARKER_DIR/$name.done" ]; then
    log "step $name: already done (rm $MARKER_DIR/$name.done to redo)"
    return 0
  fi
  log "step $name: starting"
  if ! "$fn"; then
    die "step $name failed — fix the cause above and re-run $(basename "${BASH_SOURCE[1]}") (completed steps are skipped)"
  fi
  mkdir -p "$MARKER_DIR"
  touch "$MARKER_DIR/$name.done"
  log "step $name: done"
}

# download_verify <url> <dest> <min_bytes>: resumable download (aria2c when
# present, else curl) + a size floor so a truncated file can never pass.
download_verify() {
  local url="$1" dest="$2" min_bytes="$3" size
  if [ -f "$dest" ]; then
    size=$(stat -c%s "$dest")
    if [ "$size" -ge "$min_bytes" ]; then
      log "already present: $dest"
      return 0
    fi
    log "resuming partial download: $dest ($size bytes)"
  fi
  mkdir -p "$(dirname "$dest")"
  rm -f "$dest.aria2"
  if command -v aria2c >/dev/null 2>&1; then
    aria2c -x8 -s8 -c --auto-file-renaming=false --allow-overwrite=true \
      -d "$(dirname "$dest")" -o "$(basename "$dest")" "$url" || die "download failed: $url → $dest"
  else
    curl -fL --retry 3 --retry-delay 5 -C - -o "$dest" "$url" || die "download failed: $url → $dest"
  fi
  size=$(stat -c%s "$dest")
  [ "$size" -ge "$min_bytes" ] || die "download incomplete: $dest is $size bytes (< $min_bytes)"
}

# wait_http <url> <timeout_s>: poll until 2xx or timeout (non-zero return).
wait_http() {
  local url="$1" timeout="$2" waited=0
  until curl -fsS -m 3 -o /dev/null "$url" 2>/dev/null; do
    waited=$((waited + 3))
    [ "$waited" -ge "$timeout" ] && return 1
    sleep 3
  done
  return 0
}
