#!/usr/bin/env bash
# One-time provisioning of a RunPod pod for LoRA Dataset Studio + ComfyUI +
# ai-toolkit + Ollama (Krea 2 profile). Idempotent: each completed step writes a
# marker and is skipped on re-run; delete a marker to redo just that step.
#
# Markers live in one of two places, by what the step installs:
#   /workspace/.lds-setup  - on the network volume, for things installed into
#                            /workspace (venvs, models). Survives a new pod.
#   /var/lib/lds-setup     - on the container disk, for apt packages and
#                            Ollama's binary in /usr/local. A new pod on the
#                            same volume redoes exactly these - a couple of
#                            minutes, and no model is downloaded twice.
#
# Flags (env vars): INSTALL_ML_EXTRAS=0     skip the ML extras (default: install)
#                   INSTALL_SCRAPE_EXTRAS=1 add the scraper extras (default: skip)
#                   SKIP_MODELS=1           create model folders, download nothing
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

# Two cu128 torch venvs (~18 GB) + the Krea inference set (18.5 GB) + the vision
# model (~7 GB) + the studio venv with ML extras (~4 GB) is ~48 GB before any
# training. The gated ~24 GB Krea-2-Raw training base lands in hf_home on this
# same volume at the first training run - long after this check - so the floor
# covers that too.
MIN_FREE_GB=120

NODE_PACK_REPO="https://github.com/nova452/ComfyUI-Conditioning-Rebalance"
NODE_PACK_COMMIT="aefcfa766fb9d491610a0e04112ffe99c4832b1d"  # publishes ConditioningKrea2Rebalance
# Public repo carrying all three inference files under the exact names
# backend/workflows/krea2_turbo.json loads.
HF_KREA="https://huggingface.co/AlperKTS/Krea2_FP8/resolve/main"
TORCH_INDEX="https://download.pytorch.org/whl/cu128"   # Blackwell (RTX 6000 Pro) needs cu128
VISION_MODEL="huihui_ai/qwen3-vl-abliterated:8b-instruct"

step_preflight() {
  [ -d "$WORKSPACE" ] && [ -w "$WORKSPACE" ] \
    || { warn "$WORKSPACE missing or read-only - attach a network volume mounted there"; return 1; }

  local avail_gb
  avail_gb=$(df -BG --output=avail "$WORKSPACE" | tail -1 | tr -dc '0-9')
  if [ "${avail_gb:-0}" -lt "$MIN_FREE_GB" ]; then
    warn "only ${avail_gb} GB free on $WORKSPACE - need ~${MIN_FREE_GB} GB."
    warn "Grow the network volume (150 GB recommended: the training base lands here too)."
    return 1
  fi

  command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1 \
    || { warn "no NVIDIA GPU visible (nvidia-smi failed) - use a GPU pod"; return 1; }

  local pyver
  pyver=$(python3 -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")') \
    || { warn "python3 not found"; return 1; }
  case "$pyver" in
    3.10|3.11|3.12) log "python3 $pyver OK" ;;
    *) warn "python3 is $pyver - the studio's ML extras have no wheels beyond 3.12."
       warn "Pick a pod image shipping python 3.10-3.12."
       return 1 ;;
  esac

  # HF_TOKEN is NOT needed for setup: the Krea 2 inference files are public. It
  # is needed at TRAINING time, when ai-toolkit pulls the gated base. Warn, so a
  # missing token surfaces now rather than an hour into a paid pod.
  if [ -z "${HF_TOKEN:-}" ]; then
    # A near-miss name is the likeliest reason someone who "set their token"
    # still gets a 401: nothing reads these, and the failure only surfaces much
    # later as a refused download.
    local alias_name
    for alias_name in HF_KEY HF_API_KEY HUGGINGFACE_TOKEN HUGGINGFACE_API_KEY \
                      HUGGING_FACE_HUB_TOKEN HF_ACCESS_TOKEN; do
      if [ -n "${!alias_name:-}" ]; then
        warn "found \$$alias_name set, but the variable that is read is HF_TOKEN."
        warn "Nothing reads \$$alias_name - rename it to HF_TOKEN."
      fi
    done
    warn "HF_TOKEN is not set. Setup will finish, but TRAINING will fail:"
    warn "ai-toolkit must download the gated krea/Krea-2-Raw base."
    warn "Set HF_TOKEN as a pod env var and accept the license at"
    warn "https://huggingface.co/krea/Krea-2-Raw"
  else
    # Shape first, network second: a double-paste is a 401 like any other bad
    # token, and no amount of licence-accepting fixes it. Checked without ever
    # printing the value.
    local prefixes
    prefixes=$(printf '%s' "$HF_TOKEN" | grep -o 'hf_' | wc -l | tr -d ' ')
    if [ "${prefixes:-0}" -gt 1 ]; then
      warn "HF_TOKEN carries the 'hf_' prefix $prefixes times - it looks pasted more"
      warn "than once (${#HF_TOKEN} characters; a Hugging Face token is about 37)."
      warn "Re-enter it once, in the pod's env var AND in $DATA_DIR/.env"
      return 1
    fi
    case "$HF_TOKEN" in
      *[[:space:]]*|\"*|\'*)
        warn "HF_TOKEN contains whitespace or quote characters - paste the bare token."
        return 1 ;;
    esac

    # 401 and 403 fail for completely different reasons and need different
    # fixes, so report the distinction instead of always blaming the licence.
    local code account
    # Probe a FILE, not the model metadata: /api/models/<repo> and its /tree
    # both answer 200 for this repo with no token at all, so either would report
    # a green light for a garbage token. Only resolving actual content reflects
    # whether the gate is open. 302 = redirect to the CDN, i.e. authorised.
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 \
      -H "Authorization: Bearer $HF_TOKEN" \
      "https://huggingface.co/krea/Krea-2-Raw/resolve/main/model_index.json" 2>/dev/null || echo 000)
    case "$code" in
      200|302) log "HF_TOKEN can download the gated Krea-2-Raw training base" ;;
      401) warn "Hugging Face rejected HF_TOKEN (401). The token is wrong, expired or revoked." ;;
      403)
        account=$(curl -s -m 15 -H "Authorization: Bearer $HF_TOKEN" \
          "https://huggingface.co/api/whoami-v2" 2>/dev/null \
          | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
        warn "The token is valid but cannot read krea/Krea-2-Raw (403). Two causes:"
        warn "  1. the licence was accepted on a DIFFERENT account than this token's${account:+ (this token is '$account')}"
        warn "  2. a fine-grained token needs 'Read access to contents of all public"
        warn "     gated repos you can access' ticked - a plain read token lacks it"
        warn "Accept at https://huggingface.co/krea/Krea-2-Raw, or reissue the token."
        ;;
      000) warn "could not reach huggingface.co to check HF_TOKEN - skipping this check" ;;
      *)   warn "unexpected reply $code checking HF_TOKEN against krea/Krea-2-Raw" ;;
    esac
  fi
  return 0
}

step_system_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    # zstd: Ollama's installer unpacks a zstd archive and the stock RunPod
    # images do not carry it.
    apt-get install -y -qq git curl aria2 zstd python3-venv >/dev/null
  else
    warn "apt-get not found - assuming git/curl/python3-venv are already present"
  fi
  # run_step invokes steps from a conditional, which disables `set -e` for this
  # whole body: a failed install would otherwise fall through and still mark the
  # step done. Every step therefore ends by verifying its own result.
  local tool
  for tool in git curl; do
    command -v "$tool" >/dev/null 2>&1 || { warn "$tool is missing after install"; return 1; }
  done
  python3 -m venv --help >/dev/null 2>&1 || { warn "python3 venv support is missing"; return 1; }
  command -v aria2c >/dev/null 2>&1 \
    || warn "aria2c unavailable - downloads fall back to curl (slower, still resumable)"
  return 0
}

step_comfyui() {
  if [ ! -d "$COMFY_DIR/.git" ]; then
    git clone https://github.com/comfyanonymous/ComfyUI.git "$COMFY_DIR"
  fi
  if [ ! -x "$COMFY_DIR/venv/bin/python" ]; then
    python3 -m venv "$COMFY_DIR/venv"
  fi
  "$COMFY_DIR/venv/bin/pip" install --upgrade pip -q
  # torch first, from the cu128 index, so no dependency can pull a CPU or
  # older-CUDA build in ahead of it.
  "$COMFY_DIR/venv/bin/pip" install torch torchvision torchaudio --index-url "$TORCH_INDEX"
  "$COMFY_DIR/venv/bin/pip" install -r "$COMFY_DIR/requirements.txt"

  local pack_dir="$COMFY_DIR/custom_nodes/ComfyUI-Conditioning-Rebalance"
  if [ ! -d "$pack_dir/.git" ]; then
    git clone "$NODE_PACK_REPO" "$pack_dir"
  fi
  git -C "$pack_dir" fetch --quiet origin || true
  git -C "$pack_dir" checkout --quiet "$NODE_PACK_COMMIT"
  if [ -f "$pack_dir/requirements.txt" ]; then
    "$COMFY_DIR/venv/bin/pip" install -r "$pack_dir/requirements.txt"
  fi

  "$COMFY_DIR/venv/bin/python" -c "import torch; assert torch.cuda.is_available(), 'torch sees no CUDA - is the pod image CUDA 12.8+?'" \
    || { warn "ComfyUI's environment is incomplete or cannot see the GPU"; return 1; }
  return 0
}

step_krea_models() {
  mkdir -p "$COMFY_DIR/models/unet/Krea" "$COMFY_DIR/models/text_encoders" "$COMFY_DIR/models/vae"
  if [ "${SKIP_MODELS:-0}" = "1" ]; then
    log "SKIP_MODELS=1 - folder layout created, downloads skipped"
    return 0
  fi
  download_verify "$HF_KREA/krea2_turbo_fp8.safetensors" \
    "$COMFY_DIR/models/unet/Krea/krea2_turbo_fp8.safetensors" 12000000000
  download_verify "$HF_KREA/qwen3vl_4b_fp8_scaled.safetensors" \
    "$COMFY_DIR/models/text_encoders/qwen3vl_4b_fp8_scaled.safetensors" 5000000000
  download_verify "$HF_KREA/qwen_image_vae.safetensors" \
    "$COMFY_DIR/models/vae/qwen_image_vae.safetensors" 250000000
  return 0
}

step_aitoolkit() {
  if [ ! -d "$AIT_DIR/.git" ]; then
    git clone https://github.com/ostris/ai-toolkit.git "$AIT_DIR"
  fi
  # The studio auto-detects the interpreter from a venv/ folder beside run.py.
  if [ ! -x "$AIT_DIR/venv/bin/python" ]; then
    python3 -m venv "$AIT_DIR/venv"
  fi
  "$AIT_DIR/venv/bin/pip" install --upgrade pip -q
  "$AIT_DIR/venv/bin/pip" install torch torchvision torchaudio --index-url "$TORCH_INDEX"
  "$AIT_DIR/venv/bin/pip" install -r "$AIT_DIR/requirements.txt"
  [ -f "$AIT_DIR/run.py" ] || { warn "ai-toolkit clone looks wrong: no run.py"; return 1; }
  # Verify the venv, not just the clone: a failed pip install would otherwise
  # leave this step marked done with a trainer that cannot reach the GPU.
  "$AIT_DIR/venv/bin/python" -c "import torch; assert torch.cuda.is_available(), 'ai-toolkit venv: torch sees no CUDA'" \
    || { warn "ai-toolkit's environment is incomplete - see the pip output above"; return 1; }
  return 0
}

# Ollama's installer unpacks a zstd archive. Installed here rather than relying
# on step_system_packages: anyone who provisioned before zstd was added to that
# list already carries its completion marker, so that step will never re-run for
# them. A dependency belongs to the step that needs it.
_ensure_zstd() {
  command -v zstd >/dev/null 2>&1 && return 0
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y -qq zstd >/dev/null 2>&1 \
      || { apt-get update -qq && apt-get install -y -qq zstd >/dev/null 2>&1; } \
      || true
  fi
  command -v zstd >/dev/null 2>&1 \
    || { warn "zstd is needed to unpack Ollama's installer and could not be installed"; return 1; }
}

step_ollama() {
  if ! command -v ollama >/dev/null 2>&1; then
    _ensure_zstd || return 1
    curl -fsSL https://ollama.com/install.sh | sh \
      || { warn "the Ollama installer failed - see its output above"; return 1; }
  fi
  # Fail here rather than spend 60s waiting on a server that cannot exist: the
  # installer reports its own errors and then exits, and a missing binary used
  # to surface only as an unexplained health-check timeout.
  command -v ollama >/dev/null 2>&1 \
    || { warn "ollama is still not on PATH after installing"; return 1; }
  mkdir -p "$OLLAMA_MODELS_DIR"
  # Serve just long enough to pull the vision model onto the network volume;
  # start.sh owns the long-running server.
  OLLAMA_MODELS="$OLLAMA_MODELS_DIR" OLLAMA_HOST="127.0.0.1:11434" ollama serve >/dev/null 2>&1 &
  local ollama_pid=$!
  if ! wait_http "http://127.0.0.1:11434" 60; then
    kill "$ollama_pid" 2>/dev/null || true
    warn "ollama serve did not come up within 60s"
    return 1
  fi
  local rc=0
  OLLAMA_MODELS="$OLLAMA_MODELS_DIR" OLLAMA_HOST="127.0.0.1:11434" \
    ollama pull "$VISION_MODEL" || rc=$?
  kill "$ollama_pid" 2>/dev/null || true
  return "$rc"
}

step_studio() {
  if [ ! -d "$LDS_DIR/.git" ]; then
    # Clone from wherever THIS checkout came from, so a fork provisions itself
    # instead of silently pulling someone else's code. Normally a no-op: the
    # documented flow clones into $LDS_DIR and runs this script from there, so
    # the repo is already present and this branch never runs. LDS_REPO
    # overrides for anything else.
    local repo_url="${LDS_REPO:-}"
    if [ -z "$repo_url" ]; then
      repo_url="$(git -C "$SCRIPT_DIR" remote get-url origin 2>/dev/null || true)"
    fi
    [ -n "$repo_url" ] || { warn "cannot tell which repository to clone - set LDS_REPO"; return 1; }
    log "cloning the studio from $repo_url"
    git clone "$repo_url" "$LDS_DIR"
  fi
  if [ ! -x "$LDS_DIR/.venv/bin/python" ]; then
    python3 -m venv "$LDS_DIR/.venv"
  fi
  "$LDS_DIR/.venv/bin/pip" install --upgrade pip -q
  "$LDS_DIR/.venv/bin/pip" install -r "$LDS_DIR/backend/requirements.txt"

  if [ "${INSTALL_ML_EXTRAS:-1}" = "1" ]; then
    # Mirrors the app's own ml_extras action (backend/app/setup_installer.py):
    # every ML extra EXCEPT simple-lama-inpainting, which needs Pillow<10 and
    # would downgrade this venv's Pillow 12 and break Flask. requirements.txt
    # rides along as a constraint so no pin of the app's own can be walked back.
    # Watermark inpainting installs later from the app's Setup page, which
    # auto-provisions its own isolated interpreter for exactly this reason.
    mkdir -p "$DATA_DIR"
    local ml_filtered="$DATA_DIR/ml-extras-filtered.txt"
    grep -v '^simple-lama-inpainting' "$LDS_DIR/backend/requirements-ml.txt" > "$ml_filtered"
    "$LDS_DIR/.venv/bin/pip" install -r "$ml_filtered" -c "$LDS_DIR/backend/requirements.txt"
    "$LDS_DIR/.venv/bin/python" -c "import PIL; assert PIL.__version__.startswith('12.'), f'Pillow was downgraded to {PIL.__version__}'" \
      || { warn "the ML extras downgraded Pillow - the app's venv is no longer sound"; return 1; }
  fi

  if [ "${INSTALL_SCRAPE_EXTRAS:-0}" = "1" ]; then
    "$LDS_DIR/.venv/bin/pip" install -r "$LDS_DIR/backend/requirements-scrape.txt"
  fi

  "$LDS_DIR/.venv/bin/python" -c "import flask, PIL" \
    || { warn "the studio's environment is incomplete - see the pip output above"; return 1; }
  return 0
}

step_seed_config() {
  mkdir -p "$DATA_DIR" "$LOG_DIR" "$WORKSPACE/hf-home"
  if [ -f "$DATA_DIR/config.json" ]; then
    log "config.json already exists - leaving it alone"
  else
    # require_token MUST be true: the studio binds 0.0.0.0 behind a RunPod proxy
    # URL derivable from the pod id, and netguard skips the token check entirely
    # when this is false (its default). LDS_ACCESS_TOKEN alone arms nothing.
    cat > "$DATA_DIR/config.json" <<EOF
{
  "server": { "host": "0.0.0.0", "port": 5050, "require_token": true },
  "comfyui": {
    "api_url": "http://127.0.0.1:8188",
    "base_dir": "$COMFY_DIR"
  },
  "ollama": {
    "url": "http://127.0.0.1:11434",
    "vision_model": "$VISION_MODEL"
  },
  "aitoolkit": {
    "dir": "$AIT_DIR",
    "hf_home": "$WORKSPACE/hf-home"
  },
  "training": { "default_family": "krea" }
}
EOF
    log "seeded config.json (ComfyUI, ai-toolkit, Ollama, token gate armed)"
  fi

  if [ ! -f "$DATA_DIR/.env" ]; then
    touch "$DATA_DIR/.env"
    chmod 600 "$DATA_DIR/.env"
    local key
    for key in GEMINI_API_KEY OPENAI_API_KEY PEXELS_API_KEY VAST_API_KEY HF_TOKEN; do
      if [ -n "${!key:-}" ]; then
        printf '%s=%s\n' "$key" "${!key}" >> "$DATA_DIR/.env"
        log "seeded $key into .env"      # name only, never the value
      fi
    done
  fi
  return 0
}

main() {
  log "LoRA Dataset Studio - RunPod provisioning"
  run_step preflight step_preflight
  # container scope: apt installs land on the container disk, so a new pod on
  # the same volume must redo them.
  run_step system_packages step_system_packages container
  run_step comfyui step_comfyui
  run_step krea_models step_krea_models
  run_step aitoolkit step_aitoolkit
  # container scope: the installer puts the binary in /usr/local, which is the
  # container disk. Only its MODELS live on the volume.
  run_step ollama step_ollama container
  run_step studio step_studio
  run_step seed_config step_seed_config
  log "setup complete - run $SCRIPT_DIR/start.sh next"
}

main "$@"
