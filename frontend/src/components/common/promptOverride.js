/* Editable "built-in default" prompts — the ONE rule both surfaces obey.
   PURE JS (no JSX) so node --test can import and exercise it directly.

   WHY THIS FILE EXISTS
   --------------------
   These prompts (config `identity_prompts.*`) are stored as a GLOBAL override
   whose blank value means "follow the shipped default". The backend enforces
   that literally: `face_variations.get_identity_prompt` only honours an override
   when it holds non-blank text, otherwise it returns the hardcoded constant
   byte-for-byte, and `config.DEFAULTS` ships each string as '' on purpose.

   The UI used to expose that as TWO boxes — an empty field plus a read-only
   "Built-in default (currently in use)" block with a "Load default to edit"
   button. One box is better, but pre-filling a single box with the default text
   would quietly PERSIST A COPY of it: the user follows the default today, saves
   an identical string, and every future improvement to the shipped prompt stops
   reaching them, silently and forever.

   So the single box SHOWS the default and is editable, and this module is what
   keeps the storage honest: text equal to the shipped default (ignoring only
   surrounding whitespace) normalises back to '' — "following the default" —
   and only genuinely different text is stored as an override. Every onChange
   goes through `normalizePromptOverride`, so the config never holds a frozen
   copy at any point, not just at save time. */

/** The value to STORE for a prompt box holding `value`, given the shipped
 *  `defaultText`. '' means "follow the built-in default" (the backend contract).
 *  Blank input, or input equal to the default up to surrounding whitespace,
 *  collapses to '' — anything else is a real override, kept verbatim. */
export function normalizePromptOverride(value, defaultText) {
  const raw = typeof value === 'string' ? value : '';
  if (!raw.trim()) return '';
  const def = typeof defaultText === 'string' ? defaultText : '';
  if (raw === def || raw.trim() === def.trim()) return '';
  return raw;
}

/** True when the stored value means "use the shipped default". */
export function isFollowingDefault(value, defaultText) {
  return normalizePromptOverride(value, defaultText) === '';
}

/** What the single box DISPLAYS: the override when there is one, otherwise the
 *  real shipped default (never an empty box behind a placeholder). */
export function promptBoxText(value, defaultText) {
  const raw = typeof value === 'string' ? value : '';
  if (raw) return raw;
  return typeof defaultText === 'string' ? defaultText : '';
}

/* Shared metadata for the editable identity prompts — imported by BOTH the
   Settings card and the workspace modal so the two surfaces can never drift
   apart on labels, keys or which engine a prompt actually drives.
   `key` mirrors config identity_prompts.* — NEVER renamed (persisted globally).
   `engines` says which engine family really consumes the prompt, verified in
   face_variations.py: wrap_variation picks face_multi/face_single for the API
   engines, wrap_variation_klein always uses klein_identity. */
export const IDENTITY_PROMPT_FIELDS = [
  {
    key: 'face_single',
    id: 'identity-prompt-face-single',
    label: 'API engine — identity lock (single reference)',
    engines: ['nanobanana', 'chatgpt'],
    desc: 'Prepended to every Nano Banana / ChatGPT variation made from ONE reference photo. Tells the model to keep the exact face and take outfit + expression from the description, not the reference.',
  },
  {
    key: 'face_multi',
    id: 'identity-prompt-face-multi',
    label: 'API engine — identity lock (multiple references)',
    engines: ['nanobanana', 'chatgpt'],
    desc: 'Same, but for variations generated from SEVERAL reference photos of the person — tells the model all references are the same person and to use them together.',
  },
  {
    key: 'klein_identity',
    id: 'identity-prompt-klein-identity',
    label: 'Klein — restage & face-identity block',
    engines: ['klein'],
    desc: 'The instruction block Klein (local) uses to restage the shot while keeping the face identical. Steers pose/framing/outfit changes without altering the person.',
  },
];

/* The descriptions above name a FACE and a person — true of the human set only.
   A box shown for an Animal dataset that says "keep the exact face" is what
   invites a user to rewrite it for animals; the wording has to follow the
   subject. Only the human strings above stay byte-identical (they are the ones
   users already know); the rest are derived per subject. */
const SUBJECT_NOUNS = {
  animal: { one: 'the animal', kind: 'animal', trait: 'coat, markings and build' },
  creature: { one: 'the creature', kind: 'creature', trait: 'body form, texture and features' },
  object: { one: 'the object', kind: 'object', trait: 'shape, colour and materials' },
  other: { one: 'the subject', kind: 'subject', trait: 'shape, colours and details' },
};

/** The three editable identity fields, worded for `subjectType`. Keys, ids and
 *  engine mapping never change — only the human-readable text does. */
export function identityPromptFields(subjectType) {
  const st = normalizeSubject(subjectType);
  if (st === 'human') return IDENTITY_PROMPT_FIELDS;
  const n = SUBJECT_NOUNS[st];
  const descs = {
    face_single: `Prepended to every Nano Banana / ChatGPT variation made from ONE reference photo of ${n.one}. Tells the model to preserve its ${n.trait}, and to take the pose and setting from the description, not the reference.`,
    face_multi: `Same, but for variations generated from SEVERAL reference photos of the same ${n.kind} — tells the model they all show one ${n.kind} and to use them together.`,
    klein_identity: `The instruction block Klein (local) uses to restage the shot while keeping ${n.one} identical. Steers pose/framing/setting changes without altering its ${n.trait}.`,
  };
  const labels = {
    face_single: 'API engine — identity lock (single reference)',
    face_multi: 'API engine — identity lock (multiple references)',
    klein_identity: `Klein — restage & ${n.kind}-identity block`,
  };
  return IDENTITY_PROMPT_FIELDS.map((f) => ({
    ...f, label: labels[f.key] || f.label, desc: descs[f.key] || f.desc,
  }));
}

/* --- Per-subject-type storage ------------------------------------------------
   An identity lock is written FOR A SUBJECT. Storing one text for all of them is
   what let a prompt tuned on an Animal dataset ride on human generations —
   tails, extra limbs, odd footwear (reported by ashish.sinha on Discord).

   Layout, mirroring backend face_variations.identity_prompt_config_key:
     human      -> identity_prompts.<kind>                    (the ORIGINAL key)
     non-human  -> identity_prompts.by_subject.<type>.<kind>
   Human deliberately keeps the flat key: every override written before this fix
   landed there (the editor showed human text and had no subject selector), so
   reading it as the human override preserves it with no migration. A non-human
   subject NEVER falls back to it — that fallback is the bug.
   `klein_improve` (+ its toggle) stays flat and global: it is a subject-agnostic
   quality instruction, identical in all five default tables. */

/** Which subject types own their own copy of the identity locks. */
export const PROMPT_SUBJECT_TYPES = ['human', 'animal', 'creature', 'object', 'other'];

/** The kinds scoped per subject — mirrors backend PER_SUBJECT_PROMPT_KINDS. */
export const PER_SUBJECT_PROMPT_KINDS = ['face_single', 'face_multi', 'klein_identity'];

function normalizeSubject(subjectType) {
  const s = String(subjectType || 'human').toLowerCase();
  return PROMPT_SUBJECT_TYPES.includes(s) ? s : 'human';
}

function isFlat(subjectType, kind) {
  return normalizeSubject(subjectType) === 'human'
    || !PER_SUBJECT_PROMPT_KINDS.includes(kind);
}

/** The stored override for (subjectType, kind) inside a config `identity_prompts`
 *  object — '' / undefined meaning "follow the shipped default". */
export function readIdentityPrompt(identityPrompts, subjectType, kind) {
  const ip = identityPrompts || {};
  if (isFlat(subjectType, kind)) return ip[kind];
  return ((ip.by_subject || {})[normalizeSubject(subjectType)] || {})[kind];
}

/** A NEW `identity_prompts` object with (subjectType, kind) set to `value`.
 *  Immutable: React state stays replaced, never mutated in place. */
export function writeIdentityPrompt(identityPrompts, subjectType, kind, value) {
  const ip = { ...(identityPrompts || {}) };
  if (isFlat(subjectType, kind)) {
    ip[kind] = value;
    return ip;
  }
  const st = normalizeSubject(subjectType);
  const by = { ...(ip.by_subject || {}) };
  by[st] = { ...(by[st] || {}), [kind]: value };
  ip.by_subject = by;
  return ip;
}

/** The PARTIAL `identity_prompts` patch that saves `kinds` for ONE subject type.
 *  /api/settings deep-merges, so a save from the workspace touches only the
 *  prompts of the dataset's own subject — never another subject's texts. */
export function identityPromptPatch(subjectType, kinds, identityPrompts) {
  let patch = {};
  for (const k of kinds) {
    patch = writeIdentityPrompt(
      patch, subjectType, k, readIdentityPrompt(identityPrompts, subjectType, k) ?? '');
  }
  return patch;
}

/** The shipped defaults for one subject type, from a /api/settings payload.
 *  Falls back to the flat human map so an older payload (or a failed load) still
 *  shows real text instead of an empty box. */
export function identityDefaultsFor(payload, subjectType) {
  const p = payload || {};
  const st = normalizeSubject(subjectType);
  const bySubject = p.identity_prompt_defaults_by_subject || {};
  return bySubject[st] || p.identity_prompt_defaults || {};
}

/** True when this subject type carries at least one real override — drives the
 *  "edited" dot on the Settings subject selector, so a user can SEE that another
 *  subject holds a custom prompt instead of discovering it through a bad render. */
export function subjectHasOverride(identityPrompts, subjectType) {
  return PER_SUBJECT_PROMPT_KINDS.some((k) => {
    const v = readIdentityPrompt(identityPrompts, subjectType, k);
    return typeof v === 'string' && v.trim() !== '';
  });
}

/** The multi-reference identity prompts, in the order the Extra-refs modal
 *  shows them. Extra references mean ref_count > 1, so the API engines take
 *  `face_multi`; Klein takes `klein_identity` whatever the reference count.
 *  Editing only one of the two would let a Klein user rewrite a text with NO
 *  effect on their generations — hence both, each labelled with its engine. */
export const EXTRA_REF_PROMPT_KEYS = ['face_multi', 'klein_identity'];

/** Which of the two the currently selected engine actually uses.
 *  `generator` is the workspace's persisted engine id (localStorage
 *  `datasetGenerator`, the same source VariationCatalog reads). The mapping
 *  MIRRORS VariationCatalog exactly, or the badge would point at the wrong box:
 *  nothing stored yet falls back to 'nanobanana' (its useState default), and any
 *  other value — including a legacy/unknown one — is Klein (its `isKlein` is
 *  "neither API engine"). */
export function activeExtraRefPromptKey(generator) {
  const g = String(generator || 'nanobanana').toLowerCase();
  return g === 'nanobanana' || g === 'chatgpt' ? 'face_multi' : 'klein_identity';
}

/** Same question for a MULTI-engine selection: every key at least one selected
 *  engine consumes. A run on Klein + ChatGPT really does use BOTH texts, so
 *  badging only the primary engine's box would tell the user the other one
 *  doesn't matter — the exact misunderstanding this badge exists to prevent.
 *  An empty/unknown selection falls back to the single-engine answer, so the
 *  badge never disappears on a legacy profile. */
export function activeExtraRefPromptKeys(generators) {
  const list = Array.isArray(generators) ? generators : [generators];
  const keys = new Set(list.filter(Boolean).map(activeExtraRefPromptKey));
  if (!keys.size) keys.add(activeExtraRefPromptKey(null));
  return EXTRA_REF_PROMPT_KEYS.filter((k) => keys.has(k));
}
