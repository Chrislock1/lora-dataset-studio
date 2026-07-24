/* Deployment state of ONE checkpoint row in the Checkpoints & LoRAs panel —
   the adapter that lets that panel speak the ◉ Graph's grammar.

   The two surfaces used to teach opposite things about the same operation: the
   graph offers "✓ Deployed + ⏏ Undeploy" (reversible, the training save stays),
   while the panel always offered "Import → loras/…" (even for an already
   deployed checkpoint) and hid the way back in a separate list under a red 🗑
   labelled "Delete this LoRA from ComfyUI's folder".

   So this module adds NO undeploy logic. It reshapes a panel row into the
   {node, pill} pair the graph's helpers already take, and defers to
   checkpointUndeployAction — which itself derives from checkpointDeleteTarget.
   One decision, one route, one target, three call sites. */

import {
  checkpointDeployed,
  checkpointUndeployAction,
  describeCheckpointDelete,
} from '../components/dataset/lineagePreview.js';

const tail = (s) => String(s || '').split(/[\\/]/).pop().toLowerCase();

/* Panel row + browse filter → the graph's {node, pill}, plus what the row needs
   to render: `deployed` (show ✓ Deployed instead of a second, lying "Import →")
   and `undeploy` (the action, null when the ComfyUI copy can't be addressed —
   the row then keeps a plain badge rather than a doomed button).

   `source`/`status` default to what the row itself carries: a cloud save marked
   `active` belongs to a run still syncing, which the shared guard refuses — the
   same runs whose 🗑 this panel already hides. */
export function panelCheckpointDeployment(row, {
  trainType, variant = null, baseModel = '', source = null, status = null,
} = {}) {
  const node = {
    source: source || row?.run_source || (row?.cloud ? 'cloud' : 'local'),
    run_id: row?.run_id ?? null,
    status: status || (row?.active ? 'training' : 'done'),
    train_type: trainType,
    variant,
    base_model: baseModel ?? '',
  };
  const pill = {
    step: row?.step,
    filename: row?.filename,
    final: !!row?.final,
    present: true,
    testable: row?.testable === true,
    deployed_filename: row?.deployed_filename || null,
  };
  return {
    node,
    pill,
    deployed: checkpointDeployed(pill),
    undeploy: checkpointUndeployAction(node, pill),
    // The confirmation is the graph's own wording — it already says what goes,
    // what survives, and that this can be re-deployed.
    confirmMessage: () => describeCheckpointDelete(node, pill)?.message || null,
  };
}

/* The deployed files NO row on this page accounts for: LoRAs imported before run
   tagging ("run ?"), or dropped into the folder by hand. They are exactly what
   the "In ComfyUI" list is still worth showing — every other deployed file is now
   actionable in place, next to the checkpoint it came from, and listing it twice
   under opposite tones is the confusion this wave removes.

   Deliberately computed from what the page DID claim as deployed: a file whose
   join failed for any reason stays in the list, so nothing ever becomes
   unreachable. Compared on the basename (the pool and the on-disk scan spell the
   same file differently — subfolder prefix, path separator), exactly like the
   backend's own resolution.

   A file carrying an `arch_mismatch` warning is kept even when it IS claimed
   above: that flag says "testing this here silently does nothing", and a warning
   must never be filtered out of sight to make a list tidier. */
export function orphanImportedCheckpoints(imported, deployedFilenames) {
  const claimed = new Set((deployedFilenames || []).filter(Boolean).map(tail));
  return (imported || []).filter(
    (c) => !claimed.has(tail(c?.filename)) || !!c?.arch_mismatch);
}

/* Every deployed-copy name the page is showing as "✓ Deployed", from all of its
   checkpoint lists at once — the input of orphanImportedCheckpoints. */
export function deployedFilenamesOf(...rowLists) {
  const out = [];
  for (const rows of rowLists) {
    for (const r of rows || []) {
      if (r?.testable === true && r?.deployed_filename) out.push(r.deployed_filename);
    }
  }
  return out;
}
