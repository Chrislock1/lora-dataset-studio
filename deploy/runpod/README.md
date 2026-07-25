# Run LoRA Dataset Studio on a RunPod pod

Provisions one GPU pod with the whole local stack — the studio, **ComfyUI**,
**ai-toolkit** and **Ollama** — so you can build a dataset and train a **Krea 2**
LoRA on the same machine, from one browser tab.

Everything installs onto the `/workspace` network volume, so it survives pod
stop/start and even pod re-creation on the same volume. Only the studio's port
is exposed; ComfyUI and Ollama stay on loopback.

## 1. Create the pod

| Setting | Value |
| :-- | :-- |
| Template | A RunPod PyTorch image on **CUDA 12.8 or newer** (Blackwell cards need cu128 wheels) |
| GPU | ≥ 24 GB VRAM. Reference: **RTX 6000 Pro** (96 GB) — Krea 2 trains at 1024px with room to spare |
| Network volume | **≥ 150 GB**, mounted at `/workspace` |
| Exposed HTTP port | **5050** |
| Python | 3.10–3.12 (the ML extras have no wheels beyond 3.12) |

Environment variables to set on the pod:

| Variable | Why |
| :-- | :-- |
| `HF_TOKEN` | **Needed to train.** ai-toolkit downloads the gated Krea 2 base at the first run — accept the license at <https://huggingface.co/krea/Krea-2-Raw> first. Setup only warns if it is missing, since the *inference* models are public. |
| `GEMINI_API_KEY` and/or `OPENAI_API_KEY` | Image generation. This profile does **not** install Klein, so generation runs through the API engines. |
| `LDS_ACCESS_TOKEN` | Optional. Sets the UI access token yourself; otherwise one is generated and reused across boots. |
| `INSTALL_ML_EXTRAS=0` | Optional. Skips face scoring, person masks and Bank scoring. Leave unset — Character masked training needs the masks. |
| `INSTALL_SCRAPE_EXTRAS=1` | Optional. Adds the web-scraper extras. |
| `SKIP_MODELS=1` | Optional. Creates the model folders but downloads nothing. |

## 2. Provision and start

In the pod's terminal:

```bash
cd /workspace
git clone https://github.com/perfectgf/lora-dataset-studio.git
bash lora-dataset-studio/deploy/runpod/setup.sh
bash lora-dataset-studio/deploy/runpod/start.sh
```

`setup.sh` takes a while on first run — roughly 19 GB of Krea 2 models, two
CUDA torch environments and a 7 GB vision model. It is **idempotent**: every
completed step writes a marker under `/workspace/.lds-setup/` and is skipped on
re-run, so an interrupted setup resumes where it stopped rather than starting
over.

`start.sh` prints the URL to open, with the access token already in it:

```
https://<pod-id>-5050.proxy.runpod.net/?token=<token>
```

Set `bash /workspace/lora-dataset-studio/deploy/runpod/start.sh` as the **pod
start command** so a restart brings everything back on its own.

## 3. Security model

The studio binds `0.0.0.0:5050` so RunPod's HTTPS proxy can reach it — and that
proxy URL is derivable from the pod id, so **the token gate is not optional
here**. Two things arm it, and `start.sh` refuses to start unless both are in
place:

- `server.require_token: true` in `/workspace/lds-data/config.json` (seeded by
  `setup.sh`). Without it the app skips the check entirely — its default is
  `false`, because a home LAN is trusted.
- a token value, held in `/workspace/lds-data/.access-token`.

To rotate the token: delete `.access-token` and restart. ComfyUI (8188) and
Ollama (11434) listen on loopback only and are never exposed; the studio is
their only client. API keys live in `/workspace/lds-data/.env`.

## 4. Smoke test

Work through this once on a fresh pod:

1. Open the printed URL. **Setup** should show ComfyUI, ai-toolkit and Ollama
   as detected.
2. Create a Character dataset and generate an image through Nano Banana Pro or
   ChatGPT.
3. Caption it — this exercises Ollama and the vision model.
4. **Test Studio** → run one Krea 2 render. This exercises ComfyUI, the three
   Krea files and the rebalance node.
5. **Training** → launch a Krea 2 run, watch it reach its first logged step,
   then stop it. The first run additionally downloads the ~24 GB gated base
   into `/workspace/hf-home`; the volume keeps it for later runs.

## 5. Repairing or re-running a step

Each step's marker lives in `/workspace/.lds-setup/`. Delete one and re-run
`setup.sh` to redo just that step:

```bash
rm /workspace/.lds-setup/krea_models.done   # e.g. re-verify the model downloads
bash /workspace/lora-dataset-studio/deploy/runpod/setup.sh
```

Interrupted model downloads resume rather than restart.

## 6. Troubleshooting

**A service does not come up.** `start.sh` prints the tail of the offending
log and names it. Full logs: `/workspace/lds-data/logs/{ollama,comfyui,studio}.log`.

**`torch sees no CUDA`.** The pod image predates CUDA 12.8 while the card is
Blackwell. Recreate the pod on a CUDA 12.8+ image; delete
`/workspace/.lds-setup/comfyui.done` and `aitoolkit.done`, then re-run setup.

**Setup stops on free space.** The floor is 120 GB and it is deliberate: the
models, both torch environments and the vision model come to ~48 GB, and the
24 GB training base lands on the same volume later. Grow the volume.

**Watermark inpainting shows as unavailable.** Deliberate — it needs Pillow<10
and cannot share the app's environment. Install it from the app's **Setup**
page, which builds it an isolated one.

**Training fails downloading the base.** `HF_TOKEN` is missing, or the Krea 2
license has not been accepted on that account. Both are shown by the warning
`setup.sh` prints at the start.

## What this profile installs

| Component | Where | Notes |
| :-- | :-- | :-- |
| ComfyUI + `ComfyUI-Conditioning-Rebalance` | `/workspace/ComfyUI` | Own venv, cu128 torch. The node pack publishes `ConditioningKrea2Rebalance`, which the Krea workflow uses. |
| Krea 2 inference set | `ComfyUI/models/{unet/Krea,text_encoders,vae}` | ~18.5 GB, public download |
| ai-toolkit | `/workspace/ai-toolkit` | Own venv, cu128 torch — the training engine |
| Ollama + `qwen3-vl-abliterated:8b-instruct` | `/workspace/ollama` | Captioning, framing, watermark detection |
| The studio | `/workspace/lora-dataset-studio` | Git clone, so in-app "Update & restart" keeps working |
| Runtime data | `/workspace/lds-data` | Datasets, `config.json`, `.env`, logs, access token |

Not installed here: Klein, Z-Image and SDXL models (generation runs through the
API engines), and the watermark-inpainting environment (see Troubleshooting).
