import { folderSyncNote } from './bankSync'

/** 🗃️ The state of a bank's SOURCE FOLDER as of the last automatic walk.
 *
 * Shown on the bank card and in the workspace header. It only appears when
 * something is off — files listed in the bank that are no longer on disk, or a
 * folder that has gone away entirely. Both cases are reported, never acted on:
 * the bank keeps every row and every decision, because a disconnected drive
 * must not be able to erase a triage. */
export default function FolderSyncNote({ sync }) {
  const note = folderSyncNote(sync)
  if (!note) return null
  const tone = note.tone === 'error'
    ? 'border-rose-400/40 bg-rose-500/10 text-rose-200'
    : 'border-amber-400/40 bg-amber-500/10 text-amber-200'
  return (
    <p className={`rounded-md border px-2 py-1 text-xs ${tone}`}>
      {note.tone === 'error' ? '⚠️ ' : 'ℹ️ '}{note.text}
    </p>
  )
}
