import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cropLevelState, findLevelState, hasCleanedImages, inpaintLevelState, levelCounts,
  progressSummary, rescanNote,
} from './bankWatermark.js';

const levels = (over = {}) => ({
  scanned: 10, flagged: 4, croppable: 1, inpaintable: 3,
  cropped: 0, inpainted: 0, dismissed: 0, needs_rescan: 0, ...over,
});

test('levelCounts: a missing payload reads as zeros, never NaN', () => {
  assert.deepEqual(levelCounts(null), {
    scanned: 0, flagged: 0, croppable: 0, inpaintable: 0,
    cropped: 0, inpainted: 0, dismissed: 0, needsRescan: 0,
  });
  assert.equal(levelCounts({ flagged: 'x' }).flagged, 0);
});

test('level 1 is live whenever something is croppable — it needs no model at all', () => {
  const s = cropLevelState(levels(), { live: false });
  assert.equal(s.disabled, false);
  assert.equal(s.reason, null);
  assert.equal(s.remaining, 1);
  assert.match(s.label, /Auto-crop \(1\)/);
});

test('level 1 off with marks left says to escalate, not just "disabled"', () => {
  const s = cropLevelState(levels({ croppable: 0 }));
  assert.equal(s.disabled, true);
  assert.match(s.reason, /level 2/i);
});

test('level 1 off with nothing flagged points at the scan', () => {
  assert.match(cropLevelState(levels({ flagged: 0, croppable: 0 })).reason,
    /Find watermarks/);
});

test('a running pass disables both levels with the same honest reason', () => {
  assert.match(cropLevelState(levels(), { live: true }).reason, /already running/);
  assert.match(inpaintLevelState(levels(), { live: true, lamaReady: true }).reason,
    /already running/);
});

test('level 2 spells out the install path per engine instead of failing later', () => {
  const noLama = inpaintLevelState(levels(), { lamaReady: false });
  assert.equal(noLama.disabled, true);
  assert.match(noLama.reason, /LaMa.*Quality tools/);

  const noKlein = inpaintLevelState(levels(), {
    method: 'klein', lamaReady: true, kleinReady: false,
  });
  assert.equal(noKlein.disabled, true);
  assert.match(noKlein.reason, /ComfyUI/);
});

test('level 2 works on everything still flagged, not only the non-croppable share', () => {
  // Running level 2 without level 1 must not silently ignore border marks:
  // the backend repaints them (allow_crop=False), so the count says 4, not 3.
  const s = inpaintLevelState(levels(), { lamaReady: true });
  assert.equal(s.disabled, false);
  assert.equal(s.remaining, 4);
  assert.match(s.label, /Inpaint \(4\)/);
});

test('level 2 with Klein selected only needs Klein', () => {
  const s = inpaintLevelState(levels(), {
    method: 'klein', lamaReady: false, kleinReady: true,
  });
  assert.equal(s.disabled, false);
});

test('an emptied pool reads as "done", not as "never ran"', () => {
  const done = inpaintLevelState(levels({ flagged: 0, cropped: 3 }), { lamaReady: true });
  assert.match(done.reason, /every flagged image has been handled/);
  const never = inpaintLevelState(levels({ flagged: 0, cropped: 0 }), { lamaReady: true });
  assert.match(never.reason, /Find watermarks/);
});

test('progressSummary tells done-vs-left, and an unscanned bank says so', () => {
  assert.match(progressSummary(levels({ scanned: 0 })), /Not scanned yet/);
  assert.match(progressSummary(levels()), /4 still flagged \(1 croppable, 3 to repaint\)/);
  const mid = progressSummary(levels({ cropped: 2, inpainted: 1, dismissed: 1, flagged: 0 }));
  assert.match(mid, /2 cropped, 1 repainted, 1 dismissed/);
  assert.match(mid, /nothing left flagged/);
});

test('undo only offered once something was actually cleaned', () => {
  assert.equal(hasCleanedImages(levels()), false);
  assert.equal(hasCleanedImages(levels({ cropped: 1 })), true);
  assert.equal(hasCleanedImages(levels({ inpainted: 2 })), true);
});

test('images flagged before boxes were stored are named, never silently stuck', () => {
  assert.equal(rescanNote(levels()), null);
  assert.match(rescanNote(levels({ needs_rescan: 7 })), /7 image\(s\).*Find watermarks again/);
});


// --- step 1: FIND -----------------------------------------------------------
// Detection belongs to the same ladder as the two cleaning levels: it is what
// records the box they route on. Splitting it off the panel is what made the
// feature read as two unrelated things, so its state is modelled here too.

test('find is offered when the vision model is ready, and names a rescan once scanned', () => {
  const fresh = findLevelState(levels({ scanned: 0, flagged: 0 }), { visionReady: true });
  assert.equal(fresh.disabled, false);
  assert.equal(fresh.label, '🚩 Find watermarks');

  const again = findLevelState(levels(), { visionReady: true });
  assert.equal(again.disabled, false);
  assert.equal(again.label, '🚩 Scan again');   // a second pass is a RE-scan, say so
  assert.equal(again.done, 10);
  assert.equal(again.remaining, 4);
});

test('find is off without the vision model, and says where to get it', () => {
  const s = findLevelState(levels(), { visionReady: false });
  assert.equal(s.disabled, true);
  assert.match(s.reason, /vision model/i);
  assert.match(s.reason, /Settings/);           // actionable, never a bare "unavailable"
});

test('find is off while another pass runs on the bank', () => {
  const s = findLevelState(levels(), { visionReady: true, live: true });
  assert.equal(s.disabled, true);
  assert.match(s.reason, /already running/i);
});

test('find survives a missing payload (bank never scanned)', () => {
  const s = findLevelState(null, { visionReady: true });
  assert.equal(s.disabled, false);
  assert.equal(s.done, 0);
  assert.equal(s.label, '🚩 Find watermarks');
});
