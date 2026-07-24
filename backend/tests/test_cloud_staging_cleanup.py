"""Per-run staging cleanup on the Runs hub: sizes, the targeted 🧹, and the
sparing rule both purges must share.

The hub used to offer ONE all-or-nothing "Clean finished runs" and no way to see
what a run weighed — so a 45-run / 60 GB history could only be cleaned blind.
These tests pin: the size endpoint, the per-run purge, and above all that the
per-run button can never take a run the global purge spares (and back)."""
import os

import pytest


@pytest.fixture()
def runs(app, tmp_path):
    """Four cloud runs with real staging dirs of known sizes: one done, one
    stopped, one still training, one whose pod was kept for recovery."""
    from app.extensions import db
    from app.models import CloudTrainingRun
    made = {}
    with app.app_context():
        for status, kb in (('done', 4), ('stopped', 2),
                           ('training', 8), ('error_pod_kept', 6)):
            sd = tmp_path / f'staging_{status}'
            (sd / 'samples').mkdir(parents=True)
            (sd / 'lora.safetensors').write_bytes(b'x' * (kb * 1024))
            (sd / 'samples' / 's.png').write_bytes(b'y' * 1024)
            run = CloudTrainingRun(dataset_id=1, status=status,
                                   staging_dir=str(sd),
                                   checkpoint_local_path=str(sd / 'lora.safetensors'))
            db.session.add(run)
            db.session.flush()
            made[status] = run.id
        db.session.commit()
    return made


def _clear_size_cache():
    from app.services import cloud_training as ct
    ct._staging_size_cache.clear()


def test_spare_reason_is_the_single_rule_both_purges_use(app, runs):
    from app.models import CloudTrainingRun
    from app.services import cloud_training as ct
    with app.app_context():
        get = lambda s: CloudTrainingRun.query.get(runs[s])   # noqa: E731
        assert ct.staging_spare_reason(get('done')) is None
        assert ct.staging_spare_reason(get('stopped')) is None
        assert 'still active' in ct.staging_spare_reason(get('training'))
        assert 'manual recovery' in ct.staging_spare_reason(get('error_pod_kept'))


def test_staging_sizes_reports_only_what_is_on_disk(app, runs):
    from app.services import cloud_training as ct
    _clear_size_cache()
    with app.app_context():
        sizes = ct.staging_sizes()
        # every run has a staging dir here, sizes follow the bytes written
        assert sizes[runs['done']] == (4 * 1024) + 1024
        assert sizes[runs['training']] == (8 * 1024) + 1024
        # a run whose staging is gone simply drops out (no misleading 0)
        _clear_size_cache()
        import shutil
        shutil.rmtree(ct.CloudTrainingRun.query.get(runs['stopped']).staging_dir)
        sizes = ct.staging_sizes()
        assert runs['stopped'] not in sizes
        # narrowing to the shown cards only walks those
        assert set(ct.staging_sizes([runs['done']])) == {runs['done']}


def test_purge_one_run_trashes_only_that_run(app, runs):
    from app.models import CloudTrainingRun
    from app.services import cloud_training as ct
    _clear_size_cache()
    with app.app_context():
        target = CloudTrainingRun.query.get(runs['done'])
        target_dir = target.staging_dir
        other_dir = CloudTrainingRun.query.get(runs['stopped']).staging_dir
        res = ct.purge_run_staging(runs['done'])
        assert res['purged'] is True
        assert res['freed_bytes'] == (4 * 1024) + 1024
        assert not os.path.isdir(target_dir)      # moved to the trash
        assert os.path.isdir(other_dir)           # the neighbour is untouched
        # the stale "checkpoint on disk" claim is cleared, like the global purge
        assert CloudTrainingRun.query.get(runs['done']).checkpoint_local_path is None
        # …and the history row itself survives
        assert CloudTrainingRun.query.get(runs['done']) is not None


def test_purge_one_run_refuses_the_runs_the_global_purge_spares(app, runs):
    from app.models import CloudTrainingRun
    from app.services import cloud_training as ct
    with app.app_context():
        for status in ('training', 'error_pod_kept'):
            with pytest.raises(ValueError):
                ct.purge_run_staging(runs[status])
            assert os.path.isdir(CloudTrainingRun.query.get(runs[status]).staging_dir)
        with pytest.raises(ValueError):
            ct.purge_run_staging(999999)


def test_purge_one_run_twice_is_an_honest_no_op(app, runs):
    from app.services import cloud_training as ct
    with app.app_context():
        ct.purge_run_staging(runs['done'])
        again = ct.purge_run_staging(runs['done'])
        assert again == {'purged': False, 'freed_bytes': 0, 'already_clean': True}


def test_global_purge_reports_already_clean_instead_of_a_bare_zero(app, runs):
    from app.services import cloud_training as ct
    with app.app_context():
        first = ct.purge_finished_runs()
        # done + stopped only — the active run and the kept pod are spared
        assert first['purged_runs'] == 2
        assert first['freed_bytes'] == (4 * 1024 + 1024) + (2 * 1024 + 1024)
        assert first['already_clean'] is False
        # nothing left to purge: the caller can say so instead of "0 run(s), 0.0 GB"
        second = ct.purge_finished_runs()
        assert second['purged_runs'] == 0
        assert second['already_clean'] is True


def test_routes_expose_sizes_and_the_targeted_purge(client, app, runs):
    _clear_size_cache()
    r = client.get('/api/dataset/train/cloud/staging-sizes')
    assert r.status_code == 200
    body = r.get_json()
    assert body['ok'] is True
    assert body['sizes'][str(runs['done'])] == (4 * 1024) + 1024
    assert body['total_bytes'] == sum(body['sizes'].values())
    # narrowed
    r = client.get(f"/api/dataset/train/cloud/staging-sizes?run_ids={runs['done']}")
    assert set(r.get_json()['sizes']) == {str(runs['done'])}
    r = client.get('/api/dataset/train/cloud/staging-sizes?run_ids=abc')
    assert r.status_code == 400

    r = client.post('/api/dataset/train/cloud/purge-run', json={'run_id': runs['done']})
    assert r.status_code == 200 and r.get_json()['purged'] is True
    # a spared run is REFUSED with a reason, never a silent {'ok': True}
    r = client.post('/api/dataset/train/cloud/purge-run',
                    json={'run_id': runs['error_pod_kept']})
    assert r.status_code == 400
    assert 'recovery' in r.get_json()['error']
    r = client.post('/api/dataset/train/cloud/purge-run', json={})
    assert r.status_code == 400


def test_global_purge_route_carries_the_already_clean_flag(client, app, runs):
    assert client.post('/api/dataset/train/cloud/purge').get_json()['already_clean'] is False
    assert client.post('/api/dataset/train/cloud/purge').get_json()['already_clean'] is True
