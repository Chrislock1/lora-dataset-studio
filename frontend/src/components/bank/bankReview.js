/** ▶ Review — the Bank's fast-triage navigation model (pure, JSX-free so
 * `node --test` exercises it directly).
 *
 * The lightbox shows ONE image at a time and every Keep/Reject/Skip advances.
 * Two things make that non-trivial, and both live here rather than in the JSX:
 *
 * 1. A decision usually REMOVES the image from the filter you're looking at
 *    (deciding under "Undecided" is the normal case), so the grid reorders
 *    under your feet. The session therefore works off a SNAPSHOT of the ids
 *    taken when the lightbox opened, and never recomputes a position from the
 *    live list — otherwise you skip images or loop forever.
 * 2. "Random order" means a SHUFFLE, not "draw an index at random": drawing
 *    re-shows images you already judged. `order` is always a permutation of the
 *    snapshot and we walk it forward, so nothing is ever proposed twice —
 *    including Skip, which is "not now" (the image stays `pending` in the DB)
 *    but is not re-proposed in this session.
 *
 * Toggling the shuffle mid-session only ever re-orders what you have NOT seen
 * yet: the head (everything up to and including the current image) is frozen,
 * and the tail is either shuffled or restored to the snapshot's own order.
 *
 * Every function returns a NEW session object — React state updates stay a
 * plain `setSession(s => …)`.
 */

/** Fisher-Yates on a copy. `rand` is injectable so tests are deterministic. */
export function shuffled(ids, rand = Math.random) {
  const a = [...ids];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const dedupe = (ids) => {
  const seen = new Set();
  return (Array.isArray(ids) ? ids : []).filter(
    (id) => id != null && !seen.has(id) && (seen.add(id), true));
};

/** Open a review session over a snapshot of ids.
 * `startId` (the ▶ button on a tile) is pulled to the front so the session
 * starts exactly where the user clicked, whatever the order. */
export function createSession(ids, opts = {}) {
  const { shuffle = false, startId = null, rand = Math.random } = opts;
  const pool = dedupe(ids);
  let order = shuffle ? shuffled(pool, rand) : [...pool];
  if (startId != null && pool.includes(startId)) {
    order = [startId, ...order.filter((id) => id !== startId)];
  }
  return { pool, order, pos: 0, shuffle: !!shuffle, decisions: {}, skipped: [] };
}

export function currentId(s) {
  return s && s.pos >= 0 && s.pos < s.order.length ? s.order[s.pos] : null;
}

export function isFinished(s) {
  return !s || s.pos >= s.order.length;
}

/** The honest readout: "12 / 340" plus what this session has decided so far. */
export function progress(s) {
  const total = s.order.length;
  const values = Object.values(s.decisions);
  return {
    position: total === 0 ? 0 : Math.min(s.pos + 1, total),
    total,
    kept: values.filter((v) => v === 'keep').length,
    rejected: values.filter((v) => v === 'reject').length,
    skipped: s.skipped.length,
    remaining: Math.max(0, total - s.pos),
  };
}

/** Move on without judging (→ / the end of a decision). Stops at the end. */
export function advance(s) {
  return isFinished(s) ? s : { ...s, pos: s.pos + 1 };
}

/** Step back (←) — explicit navigation, so re-seeing the previous image is
 * wanted here. Also the way back from the end-of-pool screen. */
export function back(s) {
  return s.pos <= 0 ? s : { ...s, pos: s.pos - 1 };
}

/** Record a decision that the server ALREADY accepted, then advance. Callers
 * must not call this on a failed POST — the image must stay under the cursor. */
export function decide(s, status) {
  const id = currentId(s);
  if (id == null) return s;
  return advance({ ...s, decisions: { ...s.decisions, [id]: status } });
}

/** "Not now": nothing is written to the DB, but it is not proposed again in
 * this session (a re-proposed skip is the most annoying thing in random mode). */
export function skip(s) {
  const id = currentId(s);
  if (id == null) return s;
  return advance({ ...s, skipped: s.skipped.includes(id) ? s.skipped : [...s.skipped, id] });
}

/** Flip the random order mid-session. The head (seen + current) is frozen; only
 * the unseen tail is re-ordered, so nothing already judged comes back. */
export function setShuffle(s, on, rand = Math.random) {
  const next = !!on;
  if (next === s.shuffle) return s;
  const head = s.order.slice(0, Math.min(s.pos + 1, s.order.length));
  const seen = new Set(head);
  // Sequential mode restores the snapshot's own order for what's left.
  const tail = s.pool.filter((id) => !seen.has(id));
  return { ...s, shuffle: next, order: [...head, ...(next ? shuffled(tail, rand) : tail)] };
}
