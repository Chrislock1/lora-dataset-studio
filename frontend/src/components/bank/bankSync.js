/** 🗃️ Bank folder sync — pure helpers (no JSX, so `node --test` can run them).
 *
 * A bank points at a LIVE folder: the backend re-walks it on the bank list and
 * on the workspace payload, and reports the outcome as `folder_sync`
 * ({added, missing, unavailable, error}). The mutation must never be silent —
 * the user has to know why their counters moved, and that a file listed in the
 * bank is no longer on disk. */

/** The one-shot notification for a walk that just happened: new files, or a
 * refusal. Returns {type, text} for the toast, or null when there is nothing
 * worth interrupting the user for (nothing added = nothing to say). */
export function folderSyncToast(sync) {
  if (!sync) return null
  if (sync.error) return { type: 'error', text: `Folder refresh — ${sync.error}` }
  const added = Number(sync.added) || 0
  if (added > 0) {
    return {
      type: 'success',
      text: `${added} new image(s) found in the folder — added to the bank.`,
    }
  }
  return null
}

/** Same, for the bank LIST (one walk per bank): a single line instead of one
 * toast per bank. Null when nothing was added anywhere. */
export function bankListSyncToast(banks) {
  const rows = Array.isArray(banks) ? banks : []
  let added = 0
  let n = 0
  for (const b of rows) {
    const a = Number(b?.folder_sync?.added) || 0
    if (a > 0) { added += a; n += 1 }
  }
  if (added <= 0) return null
  return {
    type: 'success',
    text: n === 1
      ? `${added} new image(s) found in the folder — added to the bank.`
      : `${added} new image(s) found across ${n} banks — added to them.`,
  }
}

/** The PERSISTENT note (a line in the workspace header, not a toast): the state
 * of the source folder as of the last walk. Files that disappeared are reported
 * and kept — the bank never deletes rows behind the user's back, so a folder
 * that got moved or unplugged shows up as a warning instead of a vanished
 * triage. Returns {tone, text} or null when everything is in sync. */
export function folderSyncNote(sync) {
  if (!sync) return null
  if (sync.unavailable) {
    return {
      tone: 'error',
      text: 'Source folder unavailable (moved, renamed or on a disconnected drive) — '
        + 'the bank keeps every image and decision; reconnect it to refresh.',
    }
  }
  const missing = Number(sync.missing) || 0
  if (missing > 0) {
    return {
      tone: 'warn',
      text: `${missing} image(s) listed here are no longer in the folder — their rows `
        + 'are kept (nothing is deleted for you) but they will fail to load.',
    }
  }
  return null
}
