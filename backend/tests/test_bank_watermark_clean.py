"""🚩 Bank watermark cleaning — the two manual levels (crop, then inpaint).

The invariant that governs the whole feature: a bank is a READ-ONLY view over a
folder that belongs to the user, so cleaning a watermark may never touch the
source file. Cleaned pixels live in the bank's own working directory, and every
reader that DISPLAYS or COPIES an image must prefer that blob — otherwise the
passes run for nothing and the dataset still gets the watermarked original.

Both of those are asserted here: the source is compared byte-for-byte (and by
mtime) after a full clean, and the three known readers are pinned to the single
resolver, so rebinding one of them back to abs_image_path fails a test instead
of silently un-shipping the feature.
"""
import ast
import io
import json
import os

import pytest
from PIL import Image


def _photo(size=1000, value=90):
    """A plain, readable image — the tests care about pixels moving, not content."""
    im = Image.new('RGB', (size, size), (value, value, value))
    for y in range(0, size, 40):        # a bit of structure so a crop is visible
        for x in range(size):
            im.putpixel((x, y), (250, 250, 250))
    return im


def _mkbank(client, tmp_path, files, name='WM'):
    src = tmp_path / 'src'
    for rel, im in files.items():
        p = src / rel
        os.makedirs(p.parent, exist_ok=True)
        im.save(str(p), 'JPEG', quality=92)
    r = client.post('/api/bank/create', json={'name': name, 'folder': str(src)})
    assert r.status_code == 200, r.get_json()
    return r.get_json()['id'], src


def _flag(app, bank_id, bbox, *, index=0, state='detected'):
    """Put a row in the state the detection pass leaves behind. Returns its id."""
    from app.extensions import db
    from app.models import BankImage
    with app.app_context():
        rows = (BankImage.query.filter_by(bank_id=bank_id)
                .order_by(BankImage.id.asc()).all())
        row = rows[index]
        row.watermark_state = state
        row.watermark_bbox = json.dumps(bbox) if bbox is not None else None
        db.session.commit()
        return row.id


def _row(app, image_id):
    from app.models import BankImage
    with app.app_context():
        row = db_get(BankImage, image_id)
        return (row.watermark_state, row.watermark_clean_method)


def db_get(model, pk):
    from app.extensions import db
    return db.session.get(model, pk)


def _fingerprint(path):
    """Bytes + mtime — what "the source was not touched" actually means."""
    return open(path, 'rb').read(), os.stat(path).st_mtime_ns


# A mark inside the top band of a 1000×1000 image: croppable (the crop keeps
# 950 px, above the 768 min side). Level 1's lane.
TOP_MARK = [0.1, 0.01, 0.4, 0.05]
# Small, off-centre: never croppable, LaMa's lane. Level 2's.
OFFCENTER_MARK = [0.30, 0.30, 0.36, 0.36]
# Straddles the centre: only Klein can repaint it, otherwise manual review.
CENTER_MARK = [0.40, 0.40, 0.60, 0.60]


# --- level 1: crop -----------------------------------------------------------
def test_crop_level_cleans_without_touching_the_source(client, tmp_path, app):
    """THE invariant: the crop lands in the bank's working copy, and the user's
    own file is byte-identical (and untouched by mtime) afterwards."""
    bank_id, src = _mkbank(client, tmp_path, {'a.jpg': _photo()})
    image_id = _flag(app, bank_id, TOP_MARK)
    before = _fingerprint(src / 'a.jpg')

    r = client.post(f'/api/bank/{bank_id}/watermark/crop')
    assert r.status_code == 202, r.get_json()

    assert _fingerprint(src / 'a.jpg') == before      # source never written to
    assert _row(app, image_id) == ('cleaned', 'crop')
    with app.app_context():
        from app.services import image_bank_service as banks
        blob = banks.clean_image_path(bank_id, image_id)
    assert blob.is_file()
    with Image.open(blob) as im:
        # The band up to the mark's inner edge is gone: 1000 → 950 px tall.
        assert im.height == 950 and im.width == 1000


def test_crop_level_leaves_everything_else_flagged(client, tmp_path, app):
    """Level 1 only touches what the router calls croppable — an off-centre and
    an on-subject mark stay flagged, which is exactly level 2's pool."""
    bank_id, _src = _mkbank(client, tmp_path,
                            {'a.jpg': _photo(), 'b.jpg': _photo(value=120)})
    off = _flag(app, bank_id, OFFCENTER_MARK, index=0)
    mid = _flag(app, bank_id, CENTER_MARK, index=1)

    assert client.post(f'/api/bank/{bank_id}/watermark/crop').status_code == 202

    assert _row(app, off) == ('detected', None)
    assert _row(app, mid) == ('detected', None)
    with app.app_context():
        from app.services import image_bank_service as banks
        assert not banks.clean_image_path(bank_id, off).exists()


def test_crop_level_refuses_when_there_is_nothing_flagged(client, tmp_path):
    bank_id, _src = _mkbank(client, tmp_path, {'a.jpg': _photo()})
    r = client.post(f'/api/bank/{bank_id}/watermark/crop')
    assert r.status_code == 400
    assert 'watermark scan' in r.get_json()['error']


# --- the readers: promote / thumbnail / file --------------------------------
def test_promote_hands_the_cleaned_blob_to_the_dataset(client, tmp_path, app,
                                                       monkeypatch):
    """The point of the whole feature: after a clean, the dataset must receive
    the CLEANED pixels. Captured at the import_images boundary."""
    bank_id, _src = _mkbank(client, tmp_path,
                            {'a.jpg': _photo(), 'b.jpg': _photo(value=120)})
    cleaned_id = _flag(app, bank_id, TOP_MARK, index=0)
    assert client.post(f'/api/bank/{bank_id}/watermark/crop').status_code == 202
    assert _row(app, cleaned_id)[0] == 'cleaned'

    seen = []
    from app.services import image_bank_service as banks

    def fake_import(user_id, dataset_id, blobs, **kw):
        seen.extend(blobs)
        return list(range(len(blobs))), 0
    monkeypatch.setattr(banks, 'import_images', fake_import)

    with app.app_context():
        from app.services import face_dataset_service as svc
        dataset_id = svc.create_dataset('local', 'From bank', 'bnk').id
    ids = [i['id'] for i in
           client.get(f'/api/bank/{bank_id}/images').get_json()['images']]
    client.post(f'/api/bank/{bank_id}/images/status',
                json={'ids': ids, 'status': 'keep'})
    r = client.post(f'/api/bank/{bank_id}/promote', json={'dataset_id': dataset_id})
    assert r.status_code == 202, r.get_json()

    heights = sorted(Image.open(io.BytesIO(b)).height for b in seen)
    # The cleaned image arrives cropped (950), the untouched one at full height.
    assert heights == [950, 1000]


def test_file_route_serves_cleaned_and_original_side_by_side(client, tmp_path, app):
    """?original=1 is the before/after pair — no third lightbox needed."""
    bank_id, _src = _mkbank(client, tmp_path, {'a.jpg': _photo()})
    image_id = _flag(app, bank_id, TOP_MARK)
    assert client.post(f'/api/bank/{bank_id}/watermark/crop').status_code == 202

    cleaned = client.get(f'/api/bank/{bank_id}/file/{image_id}')
    original = client.get(f'/api/bank/{bank_id}/file/{image_id}?original=1')
    assert Image.open(io.BytesIO(cleaned.data)).height == 950
    assert Image.open(io.BytesIO(original.data)).height == 1000


def test_thumbnail_follows_the_cleaned_version(client, tmp_path, app):
    """A stale thumbnail would show the watermark long after it was removed."""
    bank_id, _src = _mkbank(client, tmp_path, {'a.jpg': _photo()})
    image_id = _flag(app, bank_id, TOP_MARK)
    first = client.get(f'/api/bank/{bank_id}/thumb/{image_id}')   # cache it
    assert Image.open(io.BytesIO(first.data)).height == Image.open(
        io.BytesIO(first.data)).width                            # square source

    assert client.post(f'/api/bank/{bank_id}/watermark/crop').status_code == 202
    after = client.get(f'/api/bank/{bank_id}/thumb/{image_id}')
    with Image.open(io.BytesIO(after.data)) as im:
        assert im.height < im.width          # regenerated from the cropped blob


def test_display_and_copy_readers_are_pinned_to_the_resolver():
    """CONTRACT — the cleaned blob only reaches the user if the readers ask for
    it. Each piece of this feature can be green while the JOIN is broken, so the
    three known readers are pinned here: promotion and the thumbnail must go
    through resolved_image_path and must NOT call abs_image_path directly, and
    the file route must offer the resolver (its ?original=1 lane is the one
    place abs_image_path stays legitimate). Rebinding any of them back to the
    raw source path fails THIS test."""
    import app.routes.bank as bank_routes
    from app.services import image_bank_service as banks

    def calls(module, func_name, inner=None):
        tree = ast.parse(open(module.__file__, encoding='utf-8').read())
        node = next(n for n in ast.walk(tree)
                    if isinstance(n, ast.FunctionDef) and n.name == func_name)
        if inner:      # the job closure inside a start_* factory
            node = next(n for n in ast.walk(node)
                        if isinstance(n, ast.FunctionDef) and n.name == inner)
        return {n.func.id for n in ast.walk(node)
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)} | \
               {n.func.attr for n in ast.walk(node)
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)}

    promote = calls(banks, '_promote_job', inner='run')
    assert 'resolved_image_path' in promote
    assert 'abs_image_path' not in promote

    thumb = calls(banks, 'ensure_thumb')
    assert 'resolved_image_path' in thumb
    assert 'abs_image_path' not in thumb

    assert 'resolved_image_path' in calls(bank_routes, 'bank_file')


# --- level 2: inpaint --------------------------------------------------------
def _fake_lama(monkeypatch, *, available=True, ok=True):
    """Stand in for the LaMa subprocess: paints the file it is handed (in the
    bank's working copy — never the source) so the effect is observable."""
    from app.services import watermark_lama
    monkeypatch.setattr(watermark_lama, 'is_available', lambda: available)
    monkeypatch.setattr(watermark_lama, 'resolve_device', lambda: 'cpu')
    calls = []

    def fake_batch(jobs, *, device, timeout=900):
        out = {}
        for job in jobs:
            calls.append(job['image_path'])
            if ok:
                with Image.open(job['image_path']) as im:
                    im.convert('RGB').resize((im.width, im.height // 2)).save(
                        job['image_path'], 'WEBP', quality=92)
                out[job['image_path']] = (True, None)
            else:
                out[job['image_path']] = (False, {'kind': 'failed',
                                                  'detail': 'inpainter blew up'})
        return out
    monkeypatch.setattr(watermark_lama, 'inpaint_batch', fake_batch)
    return calls


def test_inpaint_level_repaints_what_the_crop_left(client, tmp_path, app,
                                                   monkeypatch):
    bank_id, src = _mkbank(client, tmp_path, {'a.jpg': _photo()})
    image_id = _flag(app, bank_id, OFFCENTER_MARK)
    before = _fingerprint(src / 'a.jpg')
    painted = _fake_lama(monkeypatch)

    r = client.post(f'/api/bank/{bank_id}/watermark/inpaint', json={'method': 'lama'})
    assert r.status_code == 202, r.get_json()

    assert _fingerprint(src / 'a.jpg') == before          # source still untouched
    assert _row(app, image_id) == ('cleaned', 'lama')
    # The engine was handed OUR working copy, not the user's file.
    assert len(painted) == 1
    assert str(src) not in painted[0]


def test_inpaint_level_leaves_on_subject_marks_for_klein(client, tmp_path, app,
                                                         monkeypatch):
    bank_id, _src = _mkbank(client, tmp_path, {'a.jpg': _photo()})
    image_id = _flag(app, bank_id, CENTER_MARK)
    _fake_lama(monkeypatch)

    client.post(f'/api/bank/{bank_id}/watermark/inpaint', json={'method': 'lama'})

    assert _row(app, image_id) == ('detected', None)      # still flagged, honestly


def test_inpaint_level_says_what_to_install_instead_of_failing_silently(
        client, tmp_path, app, monkeypatch):
    bank_id, _src = _mkbank(client, tmp_path, {'a.jpg': _photo()})
    image_id = _flag(app, bank_id, OFFCENTER_MARK)
    _fake_lama(monkeypatch, available=False)

    r = client.post(f'/api/bank/{bank_id}/watermark/inpaint', json={'method': 'lama'})
    assert r.status_code == 503
    assert 'not installed' in r.get_json()['error']
    assert _row(app, image_id) == ('detected', None)       # nothing half-done


def test_failed_inpaint_keeps_no_half_written_blob(client, tmp_path, app,
                                                   monkeypatch):
    bank_id, _src = _mkbank(client, tmp_path, {'a.jpg': _photo()})
    image_id = _flag(app, bank_id, OFFCENTER_MARK)
    _fake_lama(monkeypatch, ok=False)

    client.post(f'/api/bank/{bank_id}/watermark/inpaint', json={'method': 'lama'})

    assert _row(app, image_id) == ('detected', None)
    with app.app_context():
        from app.services import image_bank_service as banks
        assert not banks.clean_image_path(bank_id, image_id).exists()


def test_inpaint_level_rejects_an_unknown_engine(client, tmp_path, app):
    bank_id, _src = _mkbank(client, tmp_path, {'a.jpg': _photo()})
    _flag(app, bank_id, OFFCENTER_MARK)
    r = client.post(f'/api/bank/{bank_id}/watermark/inpaint', json={'method': 'nope'})
    assert r.status_code == 400


# --- undo / dismiss ----------------------------------------------------------
def test_undo_drops_the_cleaned_version_and_re_flags(client, tmp_path, app):
    """Undo is only ever deleting our OWN blob — that's what makes both levels
    risk-free, and it must put the image back in the cleanable pool."""
    bank_id, _src = _mkbank(client, tmp_path, {'a.jpg': _photo()})
    image_id = _flag(app, bank_id, TOP_MARK)
    client.post(f'/api/bank/{bank_id}/watermark/crop')

    r = client.post(f'/api/bank/{bank_id}/watermark/undo', json={})
    assert r.status_code == 200 and r.get_json()['restored'] == 1

    assert _row(app, image_id) == ('detected', None)
    with app.app_context():
        from app.services import image_bank_service as banks
        assert not banks.clean_image_path(bank_id, image_id).exists()
    # Full size and thumbnail are back to the original pixels.
    served = client.get(f'/api/bank/{bank_id}/file/{image_id}')
    assert Image.open(io.BytesIO(served.data)).height == 1000


def test_dismissed_images_leave_both_levels(client, tmp_path, app):
    bank_id, _src = _mkbank(client, tmp_path, {'a.jpg': _photo()})
    image_id = _flag(app, bank_id, TOP_MARK)

    r = client.post(f'/api/bank/{bank_id}/watermark/dismiss',
                    json={'image_ids': [image_id]})
    assert r.status_code == 200 and r.get_json()['dismissed'] == 1

    assert client.post(f'/api/bank/{bank_id}/watermark/crop').status_code == 400
    levels = client.get(f'/api/bank/{bank_id}/watermark/levels').get_json()
    assert levels['dismissed'] == 1 and levels['flagged'] == 0


# --- retrofit: rows flagged before the bbox was persisted --------------------
def test_legacy_flag_without_a_bbox_is_readopted_by_a_plain_scan(client, tmp_path,
                                                                 app):
    """Banks scanned by an earlier build carry 'detected' with no box. They must
    be re-picked by an ordinary scan (not only by an explicit rescan) and be
    counted out loud meanwhile — never silently invisible to both levels."""
    bank_id, _src = _mkbank(client, tmp_path, {'a.jpg': _photo()})
    _flag(app, bank_id, None)

    levels = client.get(f'/api/bank/{bank_id}/watermark/levels').get_json()
    assert levels['needs_rescan'] == 1 and levels['flagged'] == 0

    with app.app_context():
        from app.services import image_bank_service as banks
        rows = banks._watermark_scan_query(bank_id, rescan=False).all()
    assert len(rows) == 1        # a plain "Find watermarks" adopts it


def test_rescan_never_re_examines_a_dismissed_image(client, tmp_path, app):
    bank_id, _src = _mkbank(client, tmp_path, {'a.jpg': _photo()})
    _flag(app, bank_id, TOP_MARK, state='dismissed')
    with app.app_context():
        from app.services import image_bank_service as banks
        assert banks._watermark_scan_query(bank_id, rescan=True).count() == 0


# --- the per-level tallies the UI shows -------------------------------------
def test_levels_report_progress_of_each_stage(client, tmp_path, app, monkeypatch):
    bank_id, _src = _mkbank(client, tmp_path, {
        'a.jpg': _photo(), 'b.jpg': _photo(value=120), 'c.jpg': _photo(value=160)})
    _flag(app, bank_id, TOP_MARK, index=0)
    _flag(app, bank_id, OFFCENTER_MARK, index=1)
    _flag(app, bank_id, CENTER_MARK, index=2)

    levels = client.get(f'/api/bank/{bank_id}/watermark/levels').get_json()
    assert (levels['flagged'], levels['croppable'], levels['inpaintable']) == (3, 1, 2)

    client.post(f'/api/bank/{bank_id}/watermark/crop')
    levels = client.get(f'/api/bank/{bank_id}/watermark/levels').get_json()
    assert (levels['cropped'], levels['flagged'], levels['croppable']) == (1, 2, 0)

    _fake_lama(monkeypatch)
    client.post(f'/api/bank/{bank_id}/watermark/inpaint', json={'method': 'lama'})
    levels = client.get(f'/api/bank/{bank_id}/watermark/levels').get_json()
    # The on-subject mark is still flagged: LaMa doesn't repaint the subject.
    assert (levels['cropped'], levels['inpainted'], levels['flagged']) == (1, 1, 1)


def test_levels_404_on_an_unknown_bank(client):
    assert client.get('/api/bank/9999/watermark/levels').status_code == 404
