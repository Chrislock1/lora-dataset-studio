import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  TRASH_REMINDER,
  formatStagingSize,
  purgeAllResultMessage,
  purgeRunResultMessage,
  runStagingCleanup,
  stagingSpareReason,
} from './stagingCleanup.js';

const done = { source: 'cloud', run_id: 93, status: 'done' };

test('formatStagingSize: GB / MB, and nothing at all for an empty staging', () => {
  assert.equal(formatStagingSize(8.23e9), '8.2 GB');
  assert.equal(formatStagingSize(640e6), '640 MB');
  assert.equal(formatStagingSize(0), null);
  assert.equal(formatStagingSize(undefined), null);
  assert.equal(formatStagingSize('nonsense'), null);
});

test('stagingSpareReason spares exactly what the global purge spares', () => {
  assert.equal(stagingSpareReason(done), null);
  assert.equal(stagingSpareReason({ ...done, status: 'stopped' }), null);
  assert.equal(stagingSpareReason({ ...done, status: 'error' }), null);
  for (const s of ['preparing', 'provisioning', 'uploading', 'training', 'downloading', 'terminating']) {
    assert.match(stagingSpareReason({ ...done, status: s }), /still active/);
  }
  assert.match(stagingSpareReason({ ...done, status: 'error_pod_kept' }), /manual recovery/);
  // a local run has no cloud staging dir to clean
  assert.match(stagingSpareReason({ source: 'local', record_id: 4, status: 'done' }), /not a cloud run/);
});

test('the FRONT rule mirrors the BACKEND rule (one sparing law, two places)', () => {
  const svc = fs.readFileSync(
    new URL('../../../backend/app/services/cloud_training.py', import.meta.url), 'utf8');
  // both purges go through the same backend helper…
  assert.match(svc, /def staging_spare_reason\(run\)/);
  assert.match(svc, /if staging_spare_reason\(run\):\s*\n\s*continue/);
  assert.match(svc, /reason = staging_spare_reason\(run\)/);
  // …which spares the same two categories this module spares.
  assert.match(svc, /run\.status in ACTIVE_STATES/);
  assert.match(svc, /run\.status == 'error_pod_kept'/);
});

test('runStagingCleanup offers a NAMED, weighed cleanup on a finished run', () => {
  const c = runStagingCleanup(done, { 93: 8.23e9 });
  assert.equal(c.available, true);
  assert.equal(c.size, '8.2 GB');
  assert.match(c.confirmMessage, /run #93/);
  assert.match(c.confirmMessage, /8\.2 GB/);
  // the message must not let the user believe the disk is freed on the spot
  assert.match(c.confirmMessage, /empty the trash in Settings/);
  // string keys (the JSON map comes back keyed by string) work too
  assert.equal(runStagingCleanup(done, { '93': 8.23e9 }).size, '8.2 GB');
});

test('runStagingCleanup withholds the button on spared runs and on empty staging', () => {
  const active = runStagingCleanup({ ...done, status: 'training' }, { 93: 8.23e9 });
  assert.equal(active.available, false);
  assert.match(active.reason, /still active/);
  const kept = runStagingCleanup({ ...done, status: 'error_pod_kept' }, { 93: 8.23e9 });
  assert.equal(kept.available, false);
  // already purged → no size, no button, and an honest reason
  const clean = runStagingCleanup(done, {});
  assert.equal(clean.available, false);
  assert.match(clean.reason, /already gone/);
  assert.equal(clean.size, null);
});

test('the per-run toast says the space is NOT reclaimed yet', () => {
  const m = purgeRunResultMessage(done, { purged: true, freed_bytes: 8.23e9 });
  assert.equal(m.kind, 'success');
  assert.match(m.text, /run #93/);
  assert.match(m.text, /8\.2 GB/);
  assert.match(m.text, /empty the trash in Settings/);
  const none = purgeRunResultMessage(done, { purged: false, freed_bytes: 0 });
  assert.match(none.text, /nothing to clean/);
});

test('the global toast distinguishes "nothing to clean" from a real cleanup', () => {
  const ok = purgeAllResultMessage({ purged_runs: 3, freed_bytes: 62.6e9, already_clean: false });
  assert.equal(ok.kind, 'success');
  assert.match(ok.text, /Cleaned 3 runs/);
  assert.match(ok.text, /62\.6 GB/);
  // the omission that made the button look broken: the trash is on the same disk
  assert.match(ok.text, /no disk space is reclaimed yet/);

  const nothing = purgeAllResultMessage({ purged_runs: 0, freed_bytes: 0, already_clean: true });
  assert.equal(nothing.kind, 'info');
  assert.match(nothing.text, /Nothing to clean/);
  assert.doesNotMatch(nothing.text, /0\.0 GB/);

  // there WAS something, and none of it could be moved — not the same message
  const failed = purgeAllResultMessage({ purged_runs: 0, freed_bytes: 0, already_clean: false });
  assert.equal(failed.kind, 'error');
  assert.match(failed.text, /Could not clean/);
});

test('the hub wires the per-run 🧹 without paying for sizes on every poll', () => {
  const page = fs.readFileSync(new URL('../pages/CloudRunsPage.jsx', import.meta.url), 'utf8');
  // sizes come from their OWN endpoint, fetched on mount and after a cleanup —
  // never folded into the 5 s runs poll (a staging walk is thousands of files).
  assert.match(page, /\/api\/dataset\/train\/cloud\/staging-sizes/);
  assert.match(page, /useEffect\(\(\) => \{ loadStagingSizes\(\); \}, \[loadStagingSizes\]\)/);
  // …and the 5 s poll itself never sizes anything: its callback only fetches runs.
  const pollBody = page.slice(page.indexOf('const poll = useCallback'),
    page.indexOf('}, [historyLimit]);'));
  assert.ok(pollBody.length > 50);
  assert.doesNotMatch(pollBody, /staging-sizes/);
  // the button and its confirmation come from the shared helper, not from inline JSX
  assert.match(page, /const cleanup = runStagingCleanup\(run, stagingSizes\);/);
  assert.match(page, /window\.confirm\(info\.confirmMessage\)/);
  assert.match(page, /cloud\/purge-run/);
  assert.match(page, /purgeAllResultMessage\(d\)/);
  assert.ok(TRASH_REMINDER.length > 20);
});
