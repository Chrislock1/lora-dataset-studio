"""🗃️ Image bank — automatic re-inventory of the source folder.

A bank points at a LIVE folder: the user keeps dropping images into it long
after the bank was created. The refresh registers what appeared, and it is
STRICTLY ADDITIVE — a bank triaged over hours (thousands of keep/reject
decisions, scores, duplicate groups, captions) must come out of any number of
refreshes bit for bit identical. Files that vanished are counted, never dropped.
"""
import os
import random

from PIL import Image


def _photo(size=192, seed=1):
    """Structured, non-flat content — a stable dHash and a readable image. The
    disc MOVES with the seed so two images never land in the same duplicate
    group (which would make the scan legitimately rewrite dup_group)."""
    rng = random.Random(seed)
    base = rng.randrange(40, 120)
    cx, cy = rng.randrange(40, size - 40), rng.randrange(40, size - 40)
    r2 = (size / 4) ** 2
    im = Image.new('L', (size, size))
    im.putdata([min(255, int(base + 60 * x / size + 40 * y / size)
                    + (90 if (x - cx) ** 2 + (y - cy) ** 2 < r2 else 0))
                for y in range(size) for x in range(size)])
    return im.convert('RGB')


def _write(src, rel, im):
    p = os.path.join(str(src), rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    im.save(p, 'JPEG', quality=92) if p.lower().endswith('.jpg') else im.save(p)
    return p


def _mkbank(client, tmp_path, files, name='B'):
    src = tmp_path / 'src'
    for rel, im in files.items():
        _write(src, rel, im)
    r = client.post('/api/bank/create', json={'name': name, 'folder': str(src)})
    assert r.status_code == 200, r.get_json()
    return r.get_json()['id'], src


def _rows(app, bank_id):
    """{relpath: full row snapshot} — every column a triage pass can write."""
    with app.app_context():
        from app.models import BankImage
        out = {}
        for r in BankImage.query.filter_by(bank_id=bank_id).all():
            out[r.relpath.replace('\\', '/')] = {
                'id': r.id, 'status': r.status, 'reject_reason': r.reject_reason,
                'quality_state': r.quality_state, 'blur_score': r.blur_score,
                'noise_score': r.noise_score, 'uniformity_score': r.uniformity_score,
                'dhash': r.dhash, 'dup_group': r.dup_group,
                'semantic_dup_group': r.semantic_dup_group,
                'aesthetic_score': r.aesthetic_score, 'nsfw_score': r.nsfw_score,
                'style_cluster': r.style_cluster, 'watermark_state': r.watermark_state,
                'face_state': r.face_state, 'face_cluster': r.face_cluster,
                'framing': r.framing, 'caption': r.caption,
                'promoted_dataset_id': r.promoted_dataset_id,
                'width': r.width, 'height': r.height,
            }
        return out


def _by_name(client, bank_id):
    d = client.get(f'/api/bank/{bank_id}/images?limit=500').get_json()
    return {i['name']: i for i in d['images']}


# --- the safety property: a triaged bank survives a refresh ------------------
def test_refresh_adds_new_files_and_never_touches_existing_triage(client, app, tmp_path):
    bank_id, src = _mkbank(client, tmp_path, {
        'a.jpg': _photo(seed=1), 'b.jpg': _photo(seed=2),
        'sub/c.png': _photo(seed=3), 'd.png': _photo(seed=4)})
    # A full triage: scan (scores, dHash, dup groups), decisions, a caption.
    assert client.post(f'/api/bank/{bank_id}/scan', json={}).status_code == 202
    by = _by_name(client, bank_id)
    client.post(f'/api/bank/{bank_id}/images/status',
                json={'ids': [by['a.jpg']['id']], 'status': 'keep'})
    client.post(f'/api/bank/{bank_id}/images/status',
                json={'ids': [by['b.jpg']['id'], by['c.png']['id']],
                      'status': 'reject'})
    with app.app_context():
        from app.extensions import db
        from app.models import BankImage
        row = db.session.get(BankImage, by['a.jpg']['id'])
        row.caption, row.face_cluster, row.aesthetic_score = 'a woman', 1, 6.25
        db.session.commit()
    before = _rows(app, bank_id)
    assert before['a.jpg']['quality_state'] == 'ok'

    # The user drops two more images in the folder (one in a subfolder).
    _write(src, 'e.jpg', _photo(seed=5))
    _write(src, 'sub/f.png', _photo(seed=6))

    r = client.get(f'/api/bank/{bank_id}?refresh=1')
    assert r.status_code == 200
    payload = r.get_json()
    assert payload['folder_sync'] == {'added': 2, 'missing': 0,
                                      'unavailable': False, 'error': None}
    assert payload['counts']['total'] == 6

    after = _rows(app, bank_id)
    # Every pre-existing row is byte-for-byte what it was: same id, same
    # decision, same scores, same groups, same caption.
    for rel, snap in before.items():
        assert after[rel] == snap, rel
    # The new ones joined as plain unscanned pending rows.
    for rel in ('e.jpg', 'sub/f.png'):
        assert after[rel]['status'] == 'pending'
        assert after[rel]['quality_state'] is None
        assert after[rel]['dup_group'] is None
    assert payload['counts']['keep'] == 1 and payload['counts']['reject'] == 2
    assert payload['counts']['scanned'] == 4


def test_new_images_flow_into_the_incremental_scan(client, app, tmp_path):
    """The added rows are picked up by the existing (incremental) quality scan,
    and that second scan still leaves the first triage alone."""
    bank_id, src = _mkbank(client, tmp_path, {'a.jpg': _photo(seed=1)})
    client.post(f'/api/bank/{bank_id}/scan', json={})
    by = _by_name(client, bank_id)
    client.post(f'/api/bank/{bank_id}/images/status',
                json={'ids': [by['a.jpg']['id']], 'status': 'keep'})
    before = _rows(app, bank_id)

    _write(src, 'g.jpg', _photo(seed=9))
    client.get(f'/api/bank/{bank_id}?refresh=1')
    client.post(f'/api/bank/{bank_id}/scan', json={})

    payload = client.get(f'/api/bank/{bank_id}?refresh=1').get_json()
    assert payload['counts']['total'] == 2
    assert payload['counts']['scanned'] == 2
    after = _rows(app, bank_id)
    assert after['a.jpg'] == before['a.jpg']
    assert after['g.jpg']['quality_state'] == 'ok'
    assert after['g.jpg']['status'] == 'pending'


def test_a_heavily_triaged_bank_survives_at_scale(client, app, tmp_path):
    """The failure this guards against is catastrophic and irreversible: a bank
    with thousands of decisions losing them to a refresh. 300 images, triaged,
    then 40 new files — every single decision must come out identical."""
    files = {f'img{i:03d}.png': Image.new('RGB', (16, 16), (i % 251, 7, 11))
             for i in range(300)}
    bank_id, src = _mkbank(client, tmp_path, files)
    by = _by_name(client, bank_id)
    keep_ids = [by[f'img{i:03d}.png']['id'] for i in range(0, 300, 3)]
    reject_ids = [by[f'img{i:03d}.png']['id'] for i in range(1, 300, 3)]
    client.post(f'/api/bank/{bank_id}/images/status',
                json={'ids': keep_ids, 'status': 'keep'})
    client.post(f'/api/bank/{bank_id}/images/status',
                json={'ids': reject_ids, 'status': 'reject'})
    before = _rows(app, bank_id)

    for i in range(300, 340):
        _write(src, f'img{i:03d}.png', Image.new('RGB', (16, 16), (i % 251, 9, 13)))
    payload = client.get(f'/api/bank/{bank_id}?refresh=1').get_json()

    assert payload['folder_sync']['added'] == 40
    assert payload['counts']['total'] == 340
    assert payload['counts']['keep'] == len(keep_ids)
    assert payload['counts']['reject'] == len(reject_ids)
    assert payload['counts']['pending'] == 340 - len(keep_ids) - len(reject_ids)
    after = _rows(app, bank_id)
    for rel, snap in before.items():
        assert after[rel] == snap, rel


# --- files that vanished ----------------------------------------------------
def test_missing_files_are_counted_never_dropped(client, app, tmp_path):
    bank_id, src = _mkbank(client, tmp_path, {
        'a.jpg': _photo(seed=1), 'b.jpg': _photo(seed=2)})
    by = _by_name(client, bank_id)
    client.post(f'/api/bank/{bank_id}/images/status',
                json={'ids': [by['b.jpg']['id']], 'status': 'keep'})
    os.remove(os.path.join(str(src), 'b.jpg'))

    payload = client.get(f'/api/bank/{bank_id}?refresh=1').get_json()
    assert payload['folder_sync']['missing'] == 1
    assert payload['folder_sync']['added'] == 0
    assert payload['counts']['total'] == 2      # the row is still there
    assert payload['counts']['keep'] == 1       # and so is its decision


def test_unavailable_folder_reports_and_changes_nothing(client, app, tmp_path):
    """An unplugged drive / renamed folder must never look like "everything is
    gone" — no row is touched and the walk reports itself unavailable."""
    bank_id, src = _mkbank(client, tmp_path, {
        'a.jpg': _photo(seed=1), 'b.jpg': _photo(seed=2)})
    with app.app_context():
        from app.extensions import db
        from app.models import ImageBank
        db.session.get(ImageBank, bank_id).source_path = str(tmp_path / 'gone')
        db.session.commit()

    payload = client.get(f'/api/bank/{bank_id}?refresh=1').get_json()
    assert payload['folder_sync']['unavailable'] is True
    assert payload['folder_sync']['missing'] == 0   # NOT "all of them are gone"
    assert payload['counts']['total'] == 2


# --- guards -----------------------------------------------------------------
def test_refresh_respects_the_max_files_cap(client, app, tmp_path, monkeypatch):
    bank_id, src = _mkbank(client, tmp_path, {'a.jpg': _photo(seed=1)})
    from app.services import image_bank_service as banks
    monkeypatch.setattr(banks, 'BANK_MAX_FILES', 2)
    _write(src, 'b.jpg', _photo(seed=2))
    _write(src, 'c.jpg', _photo(seed=3))

    payload = client.get(f'/api/bank/{bank_id}?refresh=1').get_json()
    assert payload['folder_sync']['added'] == 0
    assert 'were not added' in (payload['folder_sync']['error'] or '')
    assert payload['counts']['total'] == 1


def test_refresh_is_idempotent_and_case_stable(client, app, tmp_path):
    bank_id, src = _mkbank(client, tmp_path, {'a.jpg': _photo(seed=1)})
    _write(src, 'B.JPG', _photo(seed=2))
    assert client.get(f'/api/bank/{bank_id}?refresh=1'
                      ).get_json()['folder_sync']['added'] == 1
    for _ in range(3):
        p = client.get(f'/api/bank/{bank_id}?refresh=1').get_json()
        assert p['folder_sync']['added'] == 0
        assert p['counts']['total'] == 2


def test_poll_without_the_flag_does_not_re_walk(client, app, tmp_path):
    """The workspace polls this route every 2 s while a job runs — the walk is
    cooldown-limited, so only the explicit open (?refresh=1) is guaranteed."""
    bank_id, src = _mkbank(client, tmp_path, {'a.jpg': _photo(seed=1)})
    client.get(f'/api/bank/{bank_id}?refresh=1')            # primes the cooldown
    _write(src, 'b.jpg', _photo(seed=2))
    assert client.get(f'/api/bank/{bank_id}').get_json()['counts']['total'] == 1
    assert client.get(f'/api/bank/{bank_id}?refresh=1'
                      ).get_json()['counts']['total'] == 2


def test_refresh_skips_a_bank_with_a_live_job(client, app, tmp_path, monkeypatch):
    bank_id, src = _mkbank(client, tmp_path, {'a.jpg': _photo(seed=1)})
    _write(src, 'b.jpg', _photo(seed=2))
    from app.services import bank_jobs
    monkeypatch.setattr(bank_jobs, 'running', lambda _bid: True)
    payload = client.get(f'/api/bank/{bank_id}?refresh=1').get_json()
    assert payload['folder_sync']['added'] == 0
    assert payload['counts']['total'] == 1


# --- the list route ---------------------------------------------------------
def test_bank_list_refreshes_every_bank(client, app, tmp_path):
    id1, src1 = _mkbank(client, tmp_path / 'one', {'a.jpg': _photo(seed=1)}, name='One')
    id2, src2 = _mkbank(client, tmp_path / 'two', {'x.jpg': _photo(seed=2)}, name='Two')
    _write(src1, 'b.jpg', _photo(seed=3))
    _write(src2, 'y.jpg', _photo(seed=4))
    _write(src2, 'z.jpg', _photo(seed=5))

    rows = {b['id']: b for b in client.get('/api/banks').get_json()['banks']}
    assert rows[id1]['folder_sync']['added'] == 1 and rows[id1]['total'] == 2
    assert rows[id2]['folder_sync']['added'] == 2 and rows[id2]['total'] == 3


def test_bank_list_ignores_the_cooldown(client, app, tmp_path):
    """Navigating to the bank list IS the user asking to see their banks — files
    dropped in a folder seconds ago must show up, cooldown or not (unlike the
    workspace's 2 s job poll, which the cooldown exists for)."""
    bank_id, src = _mkbank(client, tmp_path, {'a.jpg': _photo(seed=1)})
    client.get('/api/banks')                       # primes the cooldown
    _write(src, 'b.jpg', _photo(seed=2))
    rows = {b['id']: b for b in client.get('/api/banks').get_json()['banks']}
    assert rows[bank_id]['folder_sync']['added'] == 1
    assert rows[bank_id]['total'] == 2


def test_bank_list_survives_an_unavailable_folder(client, app, tmp_path):
    """One bank on a disconnected drive must not break the whole page."""
    id1, _ = _mkbank(client, tmp_path / 'one', {'a.jpg': _photo(seed=1)}, name='One')
    id2, src2 = _mkbank(client, tmp_path / 'two', {'x.jpg': _photo(seed=2)}, name='Two')
    with app.app_context():
        from app.extensions import db
        from app.models import ImageBank
        db.session.get(ImageBank, id1).source_path = str(tmp_path / 'nope')
        db.session.commit()
    _write(src2, 'y.jpg', _photo(seed=4))

    r = client.get('/api/banks')
    assert r.status_code == 200
    rows = {b['id']: b for b in r.get_json()['banks']}
    assert rows[id1]['folder_sync']['unavailable'] is True
    assert rows[id1]['total'] == 1
    assert rows[id2]['folder_sync']['added'] == 1
