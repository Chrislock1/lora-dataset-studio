// Identity prompts are stored PER SUBJECT TYPE (reported by ashish.sinha on
// Discord: an animal-tuned identity prompt came back as tails and extra limbs on
// human variations). These lock the storage layout the UI writes — it MUST mirror
// backend face_variations.identity_prompt_config_key, or the box the user edits
// and the text the engine reads drift apart again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMPT_SUBJECT_TYPES, PER_SUBJECT_PROMPT_KINDS, readIdentityPrompt,
  writeIdentityPrompt, identityPromptPatch, identityDefaultsFor, subjectHasOverride,
  identityPromptFields, IDENTITY_PROMPT_FIELDS,
} from './promptOverride.js';

test('human keeps the ORIGINAL flat key — no migration, nothing lost', () => {
  // Every override written before the fix landed on identity_prompts.<kind>,
  // from a UI that showed human text. Reading it as the human override is what
  // makes an existing install keep working untouched.
  const ip = { face_single: 'MY HUMAN LOCK' };
  assert.equal(readIdentityPrompt(ip, 'human', 'face_single'), 'MY HUMAN LOCK');
  assert.deepEqual(writeIdentityPrompt({}, 'human', 'face_multi', 'x'), { face_multi: 'x' });
});

test('a non-human subject writes its own branch and NEVER reads the flat key', () => {
  const ip = writeIdentityPrompt({ face_single: 'HUMAN' }, 'animal', 'face_single', 'ANIMAL');
  assert.deepEqual(ip, { face_single: 'HUMAN', by_subject: { animal: { face_single: 'ANIMAL' } } });
  assert.equal(readIdentityPrompt(ip, 'animal', 'face_single'), 'ANIMAL');
  assert.equal(readIdentityPrompt(ip, 'human', 'face_single'), 'HUMAN');
  // THE bug: an animal text must not answer for another subject.
  assert.equal(readIdentityPrompt(ip, 'creature', 'face_single'), undefined);
  assert.equal(readIdentityPrompt({ face_single: 'HUMAN' }, 'animal', 'face_single'), undefined);
});

test('klein_improve stays flat for every subject — it is subject-agnostic', () => {
  assert.ok(!PER_SUBJECT_PROMPT_KINDS.includes('klein_improve'));
  const ip = writeIdentityPrompt({}, 'animal', 'klein_improve', 'sharpen');
  assert.deepEqual(ip, { klein_improve: 'sharpen' });
  assert.equal(readIdentityPrompt(ip, 'human', 'klein_improve'), 'sharpen');
});

test('writes are immutable — React state is replaced, never mutated', () => {
  const before = { face_single: 'a', by_subject: { animal: { face_multi: 'b' } } };
  const after = writeIdentityPrompt(before, 'animal', 'face_single', 'c');
  assert.deepEqual(before, { face_single: 'a', by_subject: { animal: { face_multi: 'b' } } });
  assert.equal(after.by_subject.animal.face_multi, 'b');   // sibling kept
});

test('an unknown subject type degrades to human, never to a bogus branch', () => {
  const ip = writeIdentityPrompt({}, 'dragonfly', 'face_single', 'x');
  assert.deepEqual(ip, { face_single: 'x' });
});

test('the save PATCH carries one subject only — a deep merge leaves the rest alone', () => {
  const ip = { face_single: 'HUMAN', face_multi: 'HUMAN-M',
    by_subject: { animal: { face_multi: 'ANIMAL-M' }, object: { face_multi: 'OBJ-M' } } };
  const patch = identityPromptPatch('animal', ['face_multi', 'klein_identity'], ip);
  assert.deepEqual(patch, { by_subject: { animal: { face_multi: 'ANIMAL-M', klein_identity: '' } } });
  // the human patch stays on the flat keys
  assert.deepEqual(identityPromptPatch('human', ['face_multi'], ip), { face_multi: 'HUMAN-M' });
});

test('defaults come from the subject the user is editing', () => {
  const payload = {
    identity_prompt_defaults: { face_single: 'HUMAN DEFAULT' },
    identity_prompt_defaults_by_subject: {
      human: { face_single: 'HUMAN DEFAULT' }, animal: { face_single: 'ANIMAL DEFAULT' },
    },
  };
  assert.equal(identityDefaultsFor(payload, 'animal').face_single, 'ANIMAL DEFAULT');
  assert.equal(identityDefaultsFor(payload, 'human').face_single, 'HUMAN DEFAULT');
  // an older payload (or a failed load) still shows real text, never an empty box
  assert.equal(identityDefaultsFor({ identity_prompt_defaults: { face_single: 'D' } },
    'animal').face_single, 'D');
  assert.deepEqual(identityDefaultsFor(null, 'animal'), {});
});

test('subjectHasOverride drives the "customised" dot', () => {
  const ip = { face_single: '  ', by_subject: { animal: { face_multi: 'X' }, object: { face_multi: '' } } };
  assert.equal(subjectHasOverride(ip, 'human'), false);   // whitespace is not an override
  assert.equal(subjectHasOverride(ip, 'animal'), true);
  assert.equal(subjectHasOverride(ip, 'object'), false);
  assert.equal(subjectHasOverride({ face_single: 'X' }, 'human'), true);
});

test('field wording follows the subject; keys and ids never do', () => {
  // A box shown on an Animal dataset that says "keep the exact face" is what
  // invited the rewrite that leaked. The human strings stay byte-identical.
  assert.equal(identityPromptFields('human'), IDENTITY_PROMPT_FIELDS);
  const animal = identityPromptFields('animal');
  assert.deepEqual(animal.map((f) => f.key), IDENTITY_PROMPT_FIELDS.map((f) => f.key));
  assert.deepEqual(animal.map((f) => f.id), IDENTITY_PROMPT_FIELDS.map((f) => f.id));
  assert.ok(animal.every((f) => /animal/i.test(`${f.label} ${f.desc}`)));
  assert.ok(!animal.some((f) => /exact face/i.test(f.desc)));
});

test('the subject list mirrors the backend SUBJECT_TYPES', () => {
  assert.deepEqual(PROMPT_SUBJECT_TYPES, ['human', 'animal', 'creature', 'object', 'other']);
});
