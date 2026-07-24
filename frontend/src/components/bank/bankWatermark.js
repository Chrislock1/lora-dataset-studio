/** 🚩 Bank watermark cleaning — the state of the two escalation levels (pure,
 * JSX-free so `node --test` exercises it directly).
 *
 * The feature is an ESCALATION, and the UI has to show where each level stands:
 * cheap and lossless first (crop off a border mark — invents no pixel), then the
 * expensive one (repaint what's left) on what the first level could not handle.
 * Both are launched by hand, so at every moment the panel must answer three
 * questions without the user guessing: how many images does THIS level still
 * have to work on, is the button live right now, and if not, WHY (and what to do
 * about it).
 *
 * Everything here derives from the /watermark/levels payload:
 *   flagged      — still carrying a watermark (both levels' pool)
 *   croppable    — of those, the ones the router would crop → level 1's share
 *   inpaintable  — the rest → level 2's share
 *   cropped / inpainted / dismissed — already handled, by which route
 *   needs_rescan — flagged by an older build with no box: nothing can route them
 */

const num = (v) => (Number.isFinite(v) ? v : 0);

/** Normalized counters — a missing/half-loaded payload reads as all-zero rather
 * than rendering NaNs. */
export function levelCounts(levels) {
  const l = levels || {};
  return {
    scanned: num(l.scanned),
    unscanned: num(l.unscanned),
    flagged: num(l.flagged),
    croppable: num(l.croppable),
    inpaintable: num(l.inpaintable),
    cropped: num(l.cropped),
    inpainted: num(l.inpainted),
    dismissed: num(l.dismissed),
    needsRescan: num(l.needs_rescan),
  };
}

/** Step 1 — FIND. Detection is the first rung of the same ladder, not a pass
 * that lives elsewhere: the two cleaning levels are dead without it (they route
 * on the box it stores), and splitting them across the page is what made the
 * feature read as two unrelated things. Needs the vision model. */
export function findLevelState(levels, { live = false, visionReady = false } = {}) {
  const c = levelCounts(levels);
  const reason = live
    ? 'A pass is already running on this bank — wait for it to finish.'
    : !visionReady
      ? 'Pull the vision model (Settings ▸ Captioning & quality) to scan for watermarks.'
      : null;
  return {
    done: c.scanned,
    // What is LEFT TO SCAN — not what was flagged. Detection resumes where a
    // stop left it, but a per-run progress bar restarting at 0 made that look
    // like a fresh start over already-analysed images. Naming the remainder is
    // what makes "it picked up where it stopped" visible.
    remaining: c.unscanned,
    disabled: reason !== null,
    reason,
    label: c.unscanned > 0 && c.scanned > 0
      ? `🚩 Scan the remaining ${c.unscanned}`
      : c.scanned > 0 ? '🚩 Scan again' : '🚩 Find watermarks',
  };
}

/** Level 1 — auto-crop. Always available (CPU/PIL), so the only reasons it can
 * be off are "a pass is already running" and "nothing to crop". */
export function cropLevelState(levels, { live = false } = {}) {
  const c = levelCounts(levels);
  const reason = live
    ? 'A pass is already running on this bank — wait for it to finish.'
    : c.croppable === 0
      ? (c.flagged > 0
        ? 'Nothing to crop: the remaining marks are not in a border, or cropping '
          + 'would shrink the image too much. Use level 2.'
        : 'Nothing flagged — run 🚩 Find watermarks first.')
      : null;
  return {
    done: c.cropped,
    remaining: c.croppable,
    disabled: reason !== null,
    reason,
    label: `✂ Auto-crop (${c.croppable})`,
  };
}

/** Level 2 — inpaint. `method` is the engine toggle: 'lama' (or 'auto') repaints
 * small off-centre marks and leaves marks ON the subject flagged; 'klein' also
 * repaints those. An engine that isn't installed disables the button with the
 * install path spelled out — never a silent failure mid-pass. */
export function inpaintLevelState(levels, {
  live = false, method = 'auto', lamaReady = false, kleinReady = false,
} = {}) {
  const c = levelCounts(levels);
  const wantsKlein = method === 'klein';
  const engineReady = wantsKlein ? kleinReady : lamaReady;
  const reason = live
    ? 'A pass is already running on this bank — wait for it to finish.'
    : !engineReady
      ? (wantsKlein
        ? 'Klein inpainting needs ComfyUI running and the Klein models (Setup ▸ ComfyUI).'
        : 'LaMa inpainting is not installed yet (Setup ▸ Quality tools).')
      : c.flagged === 0
        ? (c.cropped > 0
          ? 'Nothing left — every flagged image has been handled.'
          : 'Nothing flagged — run 🚩 Find watermarks first.')
        : null;
  return {
    done: c.inpainted,
    remaining: c.flagged,
    disabled: reason !== null,
    reason,
    label: `🧽 Inpaint (${c.flagged})`,
  };
}

/** True once anything has been cleaned — the Undo affordance's condition. */
export function hasCleanedImages(levels) {
  const c = levelCounts(levels);
  return c.cropped + c.inpainted > 0;
}

/** The one-line status above the two buttons. Says what is left AND what has
 * been done, because "0 flagged" alone can't be told apart from "never ran". */
export function progressSummary(levels) {
  const c = levelCounts(levels);
  if (c.scanned === 0) return 'Not scanned yet — run 🚩 Find watermarks to flag the marked images.';
  // A PARTIAL scan must say so first. Reporting "N still flagged" while
  // thousands of images were never looked at reads as a finished pass, and it
  // is the same misreading that makes a resumed scan look like it started over.
  const partial = c.unscanned > 0
    ? `${c.scanned} of ${c.scanned + c.unscanned} scanned — ${c.unscanned} still to look at. `
    : '';
  const done = [];
  if (c.cropped) done.push(`${c.cropped} cropped`);
  if (c.inpainted) done.push(`${c.inpainted} repainted`);
  if (c.dismissed) done.push(`${c.dismissed} dismissed`);
  const left = c.flagged === 0
    ? 'nothing left flagged'
    : `${c.flagged} still flagged (${c.croppable} croppable, ${c.inpaintable} to repaint)`;
  return partial + (done.length ? `${done.join(', ')} — ${left}.` : `${left}.`);
}

/** Rows a previous build flagged without keeping the box: they are invisible to
 * both levels until a scan re-adopts them, so say it instead of losing them. */
export function rescanNote(levels) {
  const c = levelCounts(levels);
  if (!c.needsRescan) return null;
  return `${c.needsRescan} image(s) were flagged before the marks' positions were `
    + 'recorded — run 🚩 Find watermarks again to make them cleanable.';
}
