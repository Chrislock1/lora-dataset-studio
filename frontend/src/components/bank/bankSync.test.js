import test from 'node:test';
import assert from 'node:assert/strict';
import { bankListSyncToast, folderSyncNote, folderSyncToast } from './bankSync.js';

const clean = { added: 0, missing: 0, unavailable: false, error: null };

test('folderSyncToast: nothing added -> silent', () => {
  assert.equal(folderSyncToast(clean), null);
  assert.equal(folderSyncToast(null), null);
  assert.equal(folderSyncToast(undefined), null);
});

test('folderSyncToast: new files are announced (the counters must never move mutely)', () => {
  const t = folderSyncToast({ ...clean, added: 42 });
  assert.equal(t.type, 'success');
  assert.match(t.text, /42 new image\(s\)/);
});

test('folderSyncToast: a refusal (max files) surfaces as an error', () => {
  const t = folderSyncToast({ ...clean, error: 'the folder now holds more than 50000 images — the new files were not added' });
  assert.equal(t.type, 'error');
  assert.match(t.text, /were not added/);
});

test('bankListSyncToast: aggregates one line for the whole list', () => {
  assert.equal(bankListSyncToast([{ folder_sync: clean }, {}]), null);
  const one = bankListSyncToast([{ folder_sync: { ...clean, added: 3 } }, { folder_sync: clean }]);
  assert.match(one.text, /^3 new image\(s\) found in the folder/);
  const many = bankListSyncToast([
    { folder_sync: { ...clean, added: 3 } },
    { folder_sync: { ...clean, added: 4 } },
  ]);
  assert.match(many.text, /7 new image\(s\) found across 2 banks/);
});

test('folderSyncNote: in sync -> no note', () => {
  assert.equal(folderSyncNote(clean), null);
  assert.equal(folderSyncNote(null), null);
});

test('folderSyncNote: missing files are reported as KEPT, never deleted', () => {
  const n = folderSyncNote({ ...clean, missing: 7 });
  assert.equal(n.tone, 'warn');
  assert.match(n.text, /7 image\(s\)/);
  assert.match(n.text, /kept/);
});

test('folderSyncNote: an unavailable folder says the bank is intact', () => {
  const n = folderSyncNote({ ...clean, unavailable: true, missing: 0 });
  assert.equal(n.tone, 'error');
  assert.match(n.text, /unavailable/);
  assert.match(n.text, /keeps every image and decision/);
});

test('folderSyncNote: unavailable wins over a stale missing count', () => {
  assert.match(folderSyncNote({ ...clean, unavailable: true, missing: 900 }).text,
    /unavailable/);
});
