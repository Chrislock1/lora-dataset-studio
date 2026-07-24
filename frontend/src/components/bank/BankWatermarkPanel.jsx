/**
 * 🚩 Watermark cleaning — the Bank's two-level escalation, launched by hand.
 *
 * A bank points at a folder that belongs to the user and we NEVER write to it,
 * so a cleaned image is a separate copy kept by the app; the original stays on
 * disk untouched. That is what lets both levels be tried freely: ↩ Undo just
 * throws our copy away.
 *
 * Level 1 (✂ Auto-crop) cuts off marks sitting in a border — no model, no GPU,
 * and it invents no pixel. Level 2 (🧽 Inpaint) repaints whatever level 1 could
 * not handle, with LaMa (fast) or Klein (slower, also handles marks ON the
 * subject). Each level shows its own remaining/handled counts, because the whole
 * point is to see how far down the funnel the bank already is.
 *
 * All of the "which button is live, and why not" logic lives in the JSX-free
 * `bankWatermark.js` so `node --test` covers it; this file is the shell.
 */
import { useCallback, useEffect, useState } from 'react'
import { apiFetch, postJson } from '../../api/fetchClient'
import { useCapabilities } from '../../context/CapabilitiesContext'
import { useToast } from '../common/Toast'
import {
  cropLevelState, findLevelState, hasCleanedImages, inpaintLevelState,
  levelCounts, progressSummary, rescanNote,
} from './bankWatermark.js'

// How many cleaned images the before/after strip offers. A sample is enough to
// judge a pass; the grid holds the full set.
const COMPARE_SAMPLE = 8

function LevelCard({ index, title, blurb, state, onRun }) {
  return (
    <div className="flex-1 min-w-[15rem] rounded-lg border border-border bg-app/40 p-2.5 space-y-1.5">
      <div className="flex items-baseline gap-1.5">
        <span className="text-[0.625rem] font-bold uppercase tracking-wide text-content-subtle">
          Level {index}
        </span>
        <span className="text-sm font-semibold text-content">{title}</span>
      </div>
      <p className="text-[0.6875rem] leading-snug text-content-subtle">{blurb}</p>
      <button type="button" onClick={onRun} disabled={state.disabled} title={state.reason || title}
        className="rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 py-1.5 text-sm font-semibold text-amber-200 disabled:opacity-40">
        {state.label}
      </button>
      <p className="text-[0.6875rem] text-content-subtle">
        {state.done > 0 ? `${state.done} already handled here. ` : ''}
        {state.reason || `${state.remaining} image(s) waiting.`}
      </p>
    </div>
  )
}

export default function BankWatermarkPanel({ bankId, live, onChanged }) {
  const { caps } = useCapabilities()
  const toast = useToast()
  const [levels, setLevels] = useState(null)
  const [method, setMethod] = useState('auto')
  const [comparing, setComparing] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)

  const load = useCallback(async () => {
    try {
      setLevels(await apiFetch(`/api/bank/${bankId}/watermark/levels`))
    } catch {
      setLevels(null)                              // the panel simply says "not scanned"
    }
  }, [bankId])

  // Reload when the bank changes and every time a job ends (`live` flips back),
  // so the per-level counts follow the passes without their own poller.
  useEffect(() => { load() }, [load, live])

  const run = async (url, body, okMsg) => {
    try {
      await postJson(url, body || {})
      if (okMsg) toast.success(okMsg)
      await load()
      await onChanged?.()
    } catch (e) {
      toast.error(e?.message || 'Action failed.')
    }
  }

  const find = findLevelState(levels, { live, visionReady: !!caps.ollama?.vision_model_ready })
  const crop = cropLevelState(levels, { live })
  const inpaint = inpaintLevelState(levels, {
    live,
    method,
    lamaReady: !!caps.watermark_inpaint,
    kleinReady: !!caps.watermark_klein,
  })
  const note = rescanNote(levels)
  const cleaned = hasCleanedImages(levels)
  // A handful of already-cleaned ids, served by the levels payload — enough to
  // judge a pass, and no extra endpoint just to list them.
  const sample = (levels?.cleaned_sample || []).slice(0, COMPARE_SAMPLE)

  // COLLAPSED BY DEFAULT: watermarks are an occasional errand, not the reason
  // this page is open — an always-expanded three-card panel pushed the grid down
  // on every visit, and off a phone screen entirely. The closed header still
  // carries the state (how many flagged, or that nothing is scanned), so folding
  // it hides the controls, never the situation. Anything needing attention
  // (rows a rescan must adopt) opens it on its own.
  const [open, setOpen] = useState(false)
  useEffect(() => { if (note) setOpen(true) }, [note])
  const c = levelCounts(levels)
  const headline = c.scanned === 0
    ? 'not scanned'
    : c.flagged > 0 ? `${c.flagged} flagged` : 'nothing flagged'

  return (
    <div id="bank-watermark-cleaning" data-workspace-focus
      className="rounded-lg border border-border bg-surface-raised">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 p-3 text-left">
        <span className="text-sm font-semibold text-content">🚩 Watermarks</span>
        <span className="text-[0.6875rem] text-content-subtle">{headline}</span>
        {note && <span aria-hidden className="text-[0.6875rem] text-amber-300/90">⚠️</span>}
        <span aria-hidden className="ml-auto text-xs text-content-subtle">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
      <div className="space-y-2 px-3 pb-3">
      <p className="text-[0.6875rem] text-content-subtle">
        find them, then clear them in two manual steps — your original files are never modified
      </p>
      <p className="text-xs text-content-subtle">{progressSummary(levels)}</p>
      {note && <p className="text-xs text-amber-300/90">⚠️ {note}</p>}

      <div className="flex flex-wrap gap-2">
        <LevelCard index={1} title="Find them" state={find}
          blurb="Scans every non-rejected image for an overlaid logo/URL and records WHERE it sits — the two steps below route on that box."
          onRun={() => run(`/api/bank/${bankId}/watermark`, {},
            '🚩 Watermark scan started — Stop any time.')} />
        <LevelCard index={2} title="Crop it off" state={crop}
          blurb="Cuts the border strip holding the mark. No model, no GPU, and no invented pixel — try this one first."
          onRun={() => run(`/api/bank/${bankId}/watermark/crop`, {},
            '✂ Auto-crop started — Stop any time.')} />
        <LevelCard index={3} title="Repaint what's left" state={inpaint}
          blurb="Repaints the marks a crop can't remove. LaMa is fast; Klein is slower but also clears marks on the subject."
          onRun={() => run(`/api/bank/${bankId}/watermark/inpaint`, { method },
            '🧽 Inpainting started — Stop any time.')} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-content-subtle">
          Level 2 engine
        </span>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-app/60 p-0.5 text-xs">
          <button type="button" aria-pressed={method !== 'klein'} onClick={() => setMethod('auto')}
            title="LaMa: fast, non-generative repaint of small off-centre marks. Marks on the subject stay flagged."
            className={`rounded-md px-2.5 py-1 font-semibold ${method !== 'klein'
              ? 'bg-amber-500/25 text-amber-100' : 'text-content-subtle hover:text-content'}`}>
            LaMa <span className="font-normal opacity-70">fast</span>
          </button>
          <button type="button" aria-pressed={method === 'klein'} onClick={() => setMethod('klein')}
            disabled={!caps.watermark_klein}
            title={caps.watermark_klein
              ? 'Klein: masked Flux.2 inpaint through ComfyUI. Slower, and the only engine that clears a mark ON the subject.'
              : 'Klein inpainting needs ComfyUI running + the Klein models (Setup ▸ ComfyUI).'}
            className={`rounded-md px-2.5 py-1 font-semibold disabled:opacity-40 ${method === 'klein'
              ? 'bg-amber-500/25 text-amber-100' : 'text-content-subtle hover:text-content'}`}>
            Klein <span className="font-normal opacity-70">quality</span>
          </button>
        </div>
        {cleaned && (
          <>
            <button type="button" disabled={live}
              onClick={() => run(`/api/bank/${bankId}/watermark/undo`, {},
                'Cleaned versions removed — your originals are back.')}
              title="Throw away every cleaned version and flag those images again. Your original files were never modified, so nothing is lost."
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-content disabled:opacity-40">
              ↩ Undo cleaning
            </button>
            <button type="button" onClick={() => setComparing((v) => !v)}
              aria-expanded={comparing}
              title="Show a sample of the cleaned images so you can flip between the cleaned version and your original."
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-content">
              {comparing ? '✕ Hide before/after' : '👁 Before / after'}
            </button>
          </>
        )}
      </div>

      {comparing && sample.length > 0 && (
        <div className="space-y-1">
          <label className="flex items-center gap-1.5 text-xs text-content-subtle">
            <input type="checkbox" checked={showOriginal}
              onChange={(e) => setShowOriginal(e.target.checked)} />
            Show my original files instead of the cleaned versions
          </label>
          <ul className="flex gap-2 overflow-x-auto pb-1">
            {sample.map((id) => (
              <li key={id} className="shrink-0">
                <img alt={showOriginal ? `Original of image ${id}` : `Cleaned image ${id}`}
                  src={`/api/bank/${bankId}/file/${id}${showOriginal ? '?original=1' : ''}`}
                  className="h-28 w-auto rounded-lg border border-border object-contain" />
              </li>
            ))}
          </ul>
        </div>
      )}
      </div>
      )}
    </div>
  )
}
