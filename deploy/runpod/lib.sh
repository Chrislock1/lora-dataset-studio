#!/usr/bin/env bash
# Shared helpers for the RunPod deploy scripts. Source this; do not execute.
# Everything durable lives under /workspace (the RunPod network volume) so it
# survives pod stop/restart and pod re-creation on the same volume.

WORKSPACE="${WORKSPACE:-/workspace}"
# Two marker scopes, because two different things can be "already installed".
#   MARKER_DIR           - on the network volume: survives pod re-creation, for
#                          anything installed INTO /workspace (venvs, models).
#   CONTAINER_MARKER_DIR - on the container disk: dies with the pod, for apt
#                          packages and Ollama's binary in /usr/local.
# Recording a container-disk install on the volume is the trap: a new pod on the
# same volume then skips a step whose files are gone, and start.sh hangs on a
# binary that no longer exists.
MARKER_DIR="$WORKSPACE/.lds-setup"
CONTAINER_MARKER_DIR="${CONTAINER_MARKER_DIR:-/var/lib/lds-setup}"
DATA_DIR="$WORKSPACE/lds-data"
LOG_DIR="$DATA_DIR/logs"
COMFY_DIR="$WORKSPACE/ComfyUI"
AIT_DIR="$WORKSPACE/ai-toolkit"
LDS_DIR="$WORKSPACE/lora-dataset-studio"
OLLAMA_MODELS_DIR="$WORKSPACE/ollama"

log()  { printf '\033[1;36m[lds]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[lds] WARNING:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[lds] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# run_step <name> <fn> [scope]: skip when the step's marker exists; run <fn> and
# write the marker on success. A failed step names itself and how to retry, then
# dies. scope is 'volume' (default) or 'container' - see the marker dirs above.
run_step() {
  local name="$1" fn="$2" scope="${3:-volume}" dir="$MARKER_DIR"
  if [ "$scope" = "container" ]; then
    dir="$CONTAINER_MARKER_DIR"
    # A writable fallback matters: some images mount /var read-only.
    mkdir -p "$dir" 2>/dev/null || dir="/tmp/lds-setup"
  fi
  if [ -f "$dir/$name.done" ]; then
    log "step $name: already done (rm $dir/$name.done to redo)"
    return 0
  fi
  log "step $name: starting"
  if ! "$fn"; then
    # BASH_SOURCE[1] is the caller's file (setup.sh or start.sh), so the advice
    # names the script the operator actually ran. Defaulted for `set -u`.
    die "step $name failed - fix the cause above and re-run $(basename "${BASH_SOURCE[1]:-this script}") (completed steps are skipped)"
  fi
  mkdir -p "$dir"
  touch "$dir/$name.done"
  log "step $name: done"
}

# download_verify <url> <dest> <min_bytes>: resumable download (aria2c when
# present, else curl) + a size floor so a truncated file can never pass.
#
# Size alone cannot judge completeness here: aria2c preallocates the file at its
# full length and fills it out of order across parallel connections, so an
# interrupted 12 GB download already stats as 12 GB. aria2c's own marker is the
# reliable signal -- it keeps <dest>.aria2 for as long as the download is
# unfinished and removes it on success -- so that file gates every size check.
download_verify() {
  local url="$1" dest="$2" min_bytes="$3" size
  if [ -f "$dest.aria2" ]; then
    log "resuming interrupted download: $dest"
  elif [ -f "$dest" ]; then
    size=$(stat -c%s "$dest")
    if [ "$size" -ge "$min_bytes" ]; then
      log "already present: $dest"
      return 0
    fi
    log "resuming partial download: $dest ($size bytes)"
  fi
  mkdir -p "$(dirname "$dest")"
  if command -v aria2c >/dev/null 2>&1; then
    # -c resumes both its own interrupted downloads and a plain sequential
    # partial left by curl.
    aria2c -x8 -s8 -c --auto-file-renaming=false --allow-overwrite=true \
      -d "$(dirname "$dest")" -o "$(basename "$dest")" "$url" \
      || die "download failed: $url -> $dest"
  else
    # curl cannot read aria2c's control file, and an aria2c partial is full of
    # holes rather than sequentially complete -- appending to it would silently
    # produce a corrupt file. Start clean instead.
    if [ -f "$dest.aria2" ]; then
      warn "aria2c partial found but aria2c is unavailable - restarting this download"
      rm -f "$dest" "$dest.aria2"
    fi
    curl -fL --retry 3 --retry-delay 5 -C - -o "$dest" "$url" \
      || die "download failed: $url -> $dest"
  fi
  if [ -f "$dest.aria2" ]; then
    die "download incomplete: $dest (aria2c left its control file behind)"
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
