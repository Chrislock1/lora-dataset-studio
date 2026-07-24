/* Staging cleanup on the Runs hub — the wording and the eligibility rule of the
   🧹 buttons, kept OUT of the JSX so both are unit-tested rather than eyeballed.

   Two facts drive everything here:
     • cleaning moves a staging folder to the app's TRASH, which lives on the SAME
       disk — so "62.6 GB moved to the trash" frees nothing until the trash is
       emptied in Settings. Every message says so; hiding it is what made the
       global button look broken;
     • the per-run 🧹 must spare EXACTLY what the global purge spares (active runs,
       and pods kept for manual recovery), so the two can never disagree. That
       rule lives once, here, mirroring the backend's staging_spare_reason(). */

/* A cloud run whose pod is still working: its staging dir is being written to. */
const CLOUD_ACTIVE_STATES = ['preparing', 'provisioning', 'uploading', 'training',
  'downloading', 'terminating'];

export const TRASH_REMINDER =
  'Nothing is deleted and no disk space is reclaimed yet — empty the trash in Settings to actually free it.';

/* Why this run's staging must NOT be cleaned, or null when it is fair game.
   Mirrors backend staging_spare_reason() and adds the front-only cases: a LOCAL
   run has no cloud staging at all, and a row with no cloud run id can't be
   addressed by the per-run route. */
export function stagingSpareReason(run) {
  if (!run) return 'unknown run';
  if (run.source !== 'cloud' || run.run_id == null) return 'not a cloud run — no staging folder';
  if (CLOUD_ACTIVE_STATES.includes(run.status)) {
    return 'this run is still active — its staging is being written to';
  }
  if (run.status === 'error_pod_kept') {
    return 'its pod was kept for manual recovery — clean it up once you have retrieved what you need';
  }
  return null;
}

/* Human size of a staging folder, or null when there is nothing on disk (the
   card then shows no weight at all rather than a misleading "0 B"). GB below a
   terabyte, MB under a gigabyte — the two scales a staging dir actually lands in. */
export function formatStagingSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/* How the hub names a run in a confirmation: the cloud id it shows on the card. */
function runLabel(run) {
  return run?.run_id != null ? `run #${run.run_id}` : 'this run';
}

/* Everything the per-run 🧹 needs for ONE card: whether to offer it, the weight
   it would move, and the confirmation that NAMES both the run and that weight —
   a targeted cleanup done blind is exactly the problem this replaces.
   `sizes` is the {run_id: bytes} map from the staging-sizes endpoint; a run
   missing from it has nothing on disk, so the button is withheld (there is
   nothing to move) with an honest reason rather than a no-op click. */
export function runStagingCleanup(run, sizes = {}) {
  const reason = stagingSpareReason(run);
  const bytes = reason ? 0 : Number(sizes?.[String(run.run_id)] ?? sizes?.[run.run_id] ?? 0) || 0;
  const size = formatStagingSize(bytes);
  if (reason) return { available: false, reason, bytes: 0, size: null, confirmMessage: null };
  if (!size) {
    return { available: false, reason: 'its staging folder is already gone',
      bytes: 0, size: null, confirmMessage: null };
  }
  return {
    available: true,
    reason: null,
    bytes,
    size,
    title: `Move ${runLabel(run)}'s staging folder (${size}) to the trash — the dataset copy, samples and checkpoint duplicates this finished run left on disk`,
    confirmMessage: [
      `Move ${runLabel(run)}'s staging folder (${size}) to the trash?`,
      '',
      'It holds this finished run\'s dataset copy, its samples and its checkpoint files.',
      TRASH_REMINDER,
    ].join('\n'),
  };
}

/* The toast after a per-run 🧹. */
export function purgeRunResultMessage(run, result) {
  const size = formatStagingSize(result?.freed_bytes);
  if (!result?.purged) {
    return { kind: 'info', text: `${runLabel(run)} had no staging folder left — nothing to clean.` };
  }
  return { kind: 'success',
    text: `${runLabel(run)}: staging folder${size ? ` (${size})` : ''} moved to the trash. ${TRASH_REMINDER}` };
}

/* The toast after the GLOBAL 🧹. Distinguishes the three outcomes the old
   one-liner collapsed into a bare "Cleaned 0 run(s) — 0.0 GB": nothing left to
   clean, a real cleanup, and "there WAS something but nothing could be moved". */
export function purgeAllResultMessage(result) {
  const purged = Number(result?.purged_runs) || 0;
  if (purged > 0) {
    const size = formatStagingSize(result?.freed_bytes) || '0 KB';
    return { kind: 'success',
      text: `Cleaned ${purged} run${purged > 1 ? 's' : ''} — ${size} moved to the trash. ${TRASH_REMINDER}` };
  }
  if (result?.already_clean) {
    return { kind: 'info',
      text: 'Nothing to clean — no finished run still has a staging folder on disk.' };
  }
  return { kind: 'error',
    text: 'Could not clean any staging folder — files may be in use. Check the app log and retry.' };
}
