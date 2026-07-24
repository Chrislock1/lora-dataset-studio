import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  deployedFilenamesOf,
  orphanImportedCheckpoints,
  panelCheckpointDeployment,
} from './checkpointDeployment.js';
import { checkpointUndeployAction } from '../components/dataset/lineagePreview.js';

const ctx = { trainType: 'zimage', variant: 'turbo', baseModel: '' };

const deployedRow = {
  step: 1500, filename: 'nova_turbo_001500.safetensors', run_id: 96,
  run_source: 'cloud', testable: true,
  deployed_filename: 'z image\\lora_nova_000001500_rc96_v1.safetensors',
};
const plainRow = { step: 1000, filename: 'nova_turbo_001000.safetensors',
  run_id: 96, run_source: 'cloud', testable: false };

test('a deployed panel row offers Undeploy; a plain one offers nothing to undeploy', () => {
  const dep = panelCheckpointDeployment(deployedRow, ctx);
  assert.equal(dep.deployed, true);
  assert.equal(dep.undeploy.label, 'Undeploy');
  assert.equal(dep.undeploy.path, 'train/checkpoint/delete');
  assert.deepEqual(dep.undeploy.body,
    { filename: 'z image\\lora_nova_000001500_rc96_v1.safetensors', train_type: 'zimage' });

  const plain = panelCheckpointDeployment(plainRow, ctx);
  assert.equal(plain.deployed, false);
  assert.equal(plain.undeploy, null);
});

test('the panel adapter DELEGATES — it never rebuilds an undeploy of its own', () => {
  // Same row through the panel adapter and through the graph helper directly:
  // identical route, body and file. This is the whole point of the alignment.
  const dep = panelCheckpointDeployment(deployedRow, ctx);
  const direct = checkpointUndeployAction(dep.node, dep.pill);
  assert.deepEqual(dep.undeploy, direct);
  // …and the module owns no route string of its own.
  const src = fs.readFileSync(new URL('./checkpointDeployment.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /train\/checkpoint\/delete/);
  assert.match(src, /checkpointUndeployAction\(node, pill\)/);
});

test('a deployed row with no addressable ComfyUI copy keeps the badge, not a doomed button', () => {
  const dep = panelCheckpointDeployment({ ...deployedRow, deployed_filename: null }, ctx);
  assert.equal(dep.deployed, true);      // it IS deployed…
  assert.equal(dep.undeploy, null);      // …but the route would reject the call
});

test('a cloud save whose run is still syncing offers no undeploy (same guard as the graph)', () => {
  const dep = panelCheckpointDeployment({ ...deployedRow, active: true }, ctx);
  assert.equal(dep.undeploy, null);
});

test('the confirmation is the graph wording — reversible, and names what survives', () => {
  const msg = panelCheckpointDeployment(deployedRow, ctx).confirmMessage();
  assert.match(msg, /UNDEPLOY — REMOVE FROM COMFYUI/);
  assert.match(msg, /training save in the run folder is KEPT/);
  assert.match(msg, /deploy again/);
});

test('deployedFilenamesOf collects the claims of every list on the page', () => {
  const names = deployedFilenamesOf([plainRow], [deployedRow],
    [{ ...deployedRow, step: 3000, deployed_filename: 'z image/final.safetensors' }]);
  assert.deepEqual(names, ['z image\\lora_nova_000001500_rc96_v1.safetensors',
    'z image/final.safetensors']);
});

test('the "Also in ComfyUI" list keeps only what no checkpoint above explains', () => {
  const imported = [
    { filename: 'z image\\lora_nova_000001500_rc96_v1.safetensors', label: 'deployed above' },
    { filename: 'z image\\lora_legacy_untagged.safetensors', label: 'run ?' },
  ];
  const kept = orphanImportedCheckpoints(imported,
    deployedFilenamesOf([deployedRow]));
  assert.equal(kept.length, 1);
  assert.match(kept[0].label, /run \?/);
});

test('a failed join never hides a file, and a warning is never filtered away', () => {
  const imported = [
    { filename: 'z image\\lora_nova_000001500_rc96_v1.safetensors', label: 'claimed',
      arch_mismatch: 'sdxl', arch_label: 'SDXL' },
    { filename: 'z image\\something_else.safetensors', label: 'unclaimed' },
  ];
  // claimed BUT arch-mismatched → still listed (the warning must stay visible)
  const kept = orphanImportedCheckpoints(imported, deployedFilenamesOf([deployedRow]));
  assert.deepEqual(kept.map((c) => c.label), ['claimed', 'unclaimed']);
  // nothing claimed at all (join failed / older server) → the list is untouched
  assert.equal(orphanImportedCheckpoints(imported, []).length, 2);
});

test('the panel renders ONE deploy control at both checkpoint lists', () => {
  const panel = fs.readFileSync(
    new URL('../components/dataset/TrainingPanel.jsx', import.meta.url), 'utf8');
  // a single shared renderer, used by the run saves AND the cloud saves
  assert.equal((panel.match(/renderDeployControl\(c, \{/g) || []).length, 2);
  assert.match(panel, /const renderDeployControl = \(c, \{ onImport, importTitle \} = \{\}\) =>/);
  // "Import → …" exists only inside that renderer now — no deployed checkpoint
  // is ever offered a second import that would overwrite itself.
  assert.equal((panel.match(/Import → \{checkpointLorasLabel\}/g) || []).length, 1);
  assert.match(panel, /✓ Deployed/);
  assert.match(panel, /⏏ \$\{dep\.undeploy\.label\}/);
  // the orphan list is filtered from what the page claimed, not from a second rule
  assert.match(panel, /orphanImportedCheckpoints\(\s*imported,/);
  assert.match(panel, /otherImported\.map/);
});

test('the backend stamps deployment on the panel payload with the SHARED join', () => {
  const svc = fs.readFileSync(
    new URL('../../../backend/app/services/cloud_training.py', import.meta.url), 'utf8');
  const routes = fs.readFileSync(
    new URL('../../../backend/app/routes/training.py', import.meta.url), 'utf8');
  assert.match(svc, /def annotate_deployed_checkpoints\(/);
  // the lineage nodes go through the same annotator (one join, two surfaces)
  assert.match(svc, /annotate_deployed_checkpoints\(rec\.dataset_id, rec\.family,/);
  // …and so does the Checkpoints panel payload, per run for the local list
  assert.match(routes, /ct\.annotate_deployed_by_run\(/);
  assert.match(routes, /run_tag=\('cloud', _g\.get\('run_id'\)\)/);
});
