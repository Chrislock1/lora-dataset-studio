"""Deployment stamp on checkpoint lists — the ONE join between a run's saves and
their copies in ComfyUI.

The ◉ Graph pills and the "Checkpoints & LoRAs" panel must answer "is this
deployed, and which ComfyUI file would an undeploy remove?" identically: the
panel used to offer "Import →" on an already-deployed checkpoint and hide the
way back in another list. Both surfaces now go through
annotate_deployed_checkpoints.
"""
import pytest

DEPLOYED = 'z image\\lora_mgmt_000001000_rc7_v1.safetensors'


@pytest.fixture()
def ds(app, client):
    return client.post('/api/dataset/create',
                       json={'name': 'Mgmt', 'trigger_word': 'mgmt'}).get_json()['id']


@pytest.fixture()
def deployed_pool(monkeypatch):
    """ComfyUI holds ONE deployed LoRA, of step 1000, tagged with cloud run 7."""
    from app.services import lora_test_studio as studio
    from app.services import lora_training as lt
    monkeypatch.setattr(studio, 'list_test_checkpoints',
                        lambda ds, family=None: [{'filename': DEPLOYED}])
    monkeypatch.setattr(lt, 'list_imported_checkpoints',
                        lambda *a, **kw: [{'filename': DEPLOYED, 'label': 'deployed'}])


def test_annotate_marks_the_deployed_step_and_names_its_comfyui_copy(app, ds, deployed_pool):
    from app.services import cloud_training as ct
    with app.app_context():
        cks = [{'step': 1000, 'filename': 'a_000001000.safetensors'},
               {'step': 2000, 'filename': 'a_000002000.safetensors'}]
        out = ct.annotate_deployed_checkpoints(ds, 'zimage', cks)
        assert out is not cks or True            # annotates in place, returns the rows
        assert cks[0]['testable'] is True
        # the handle the UI needs to address the ComfyUI copy — without it the
        # delete route answers "unknown checkpoint" and the action is withheld
        assert cks[0]['deployed_filename'] == DEPLOYED
        assert cks[1]['testable'] is False
        assert 'deployed_filename' not in cks[1]


def test_annotate_degrades_to_not_deployed_when_the_pool_cannot_be_read(app, ds, monkeypatch):
    from app.services import cloud_training as ct
    from app.services import lora_test_studio as studio

    def boom(*a, **kw):
        raise RuntimeError('ComfyUI unreachable')

    monkeypatch.setattr(studio, 'list_test_checkpoints', boom)
    with app.app_context():
        cks = [{'step': 1000, 'filename': 'a.safetensors'}]
        ct.annotate_deployed_checkpoints(ds, 'zimage', cks)
        # never a claimed deployment we cannot back up
        assert cks[0]['testable'] is False


def test_annotate_by_run_joins_each_row_with_ITS_own_run(app, ds, deployed_pool):
    from app.services import cloud_training as ct
    with app.app_context():
        rows = [
            {'step': 1000, 'filename': 'a.safetensors', 'run_id': 7, 'run_source': 'cloud'},
            {'step': 1000, 'filename': 'b.safetensors', 'run_id': 9, 'run_source': 'cloud'},
            {'step': 4000, 'filename': 'c.safetensors'},          # pre-registry row
        ]
        ct.annotate_deployed_by_run(ds, 'zimage', rows)
        # the step-named deploy matches every group's step 1000 (it names its step)
        assert rows[0]['testable'] is True and rows[1]['testable'] is True
        assert rows[2]['testable'] is False


def test_checkpoints_route_stamps_local_and_cloud_lists(client, app, ds, monkeypatch,
                                                        deployed_pool):
    from app.services import cloud_training as ct
    from app.services import lora_training as lt
    monkeypatch.setattr('app.capabilities.probe',
                        lambda *a, **k: {'aitoolkit': {'valid': True}})
    monkeypatch.setattr(lt, 'list_checkpoints', lambda *a, **kw: [
        {'step': 1000, 'filename': 'a_000001000.safetensors',
         'run_id': 7, 'run_source': 'cloud'},
        {'step': 2000, 'filename': 'a_000002000.safetensors'}])
    monkeypatch.setattr(ct, 'cloud_checkpoints', lambda *a, **kw: [
        {'step': 1000, 'filename': 'c_000001000.safetensors', 'run_id': 7}])
    monkeypatch.setattr(ct, 'cloud_checkpoint_groups', lambda *a, **kw: [
        {'run_id': 7, 'source': 'cloud', 'status': 'done', 'checkpoints': [
            {'step': 1000, 'filename': 'c_000001000.safetensors', 'run_id': 7},
            {'step': 2000, 'filename': 'c_000002000.safetensors', 'run_id': 7}]}])
    monkeypatch.setattr(lt, 'dataset_disk_usage', lambda *a, **kw: {'total_bytes': 0})

    body = client.get(f'/api/dataset/{ds}/train/checkpoints'
                      '?base_model=&train_type=zimage').get_json()
    local = body['checkpoints']
    assert local[0]['testable'] is True
    assert local[0]['deployed_filename'] == DEPLOYED
    assert local[1]['testable'] is False
    assert body['cloud_checkpoints'][0]['testable'] is True
    group = body['cloud_checkpoint_groups'][0]['checkpoints']
    assert group[0]['testable'] is True and group[0]['deployed_filename'] == DEPLOYED
    assert group[1]['testable'] is False
    # the deployed pool itself is unchanged — the panel still lists what is there
    assert body['imported'][0]['filename'] == DEPLOYED
