"""Identity-prompt overrides are scoped PER SUBJECT TYPE (reported by ashish.sinha).

THE BUG, in his words: "I tested the animal generation prompts, tweaked the
default prompt as per needs. Then I switched back to a human dataset, reset the
default prompt. I started getting extra limbs, tails and weird footwear."

He missed no step. The editable identity prompt was stored under ONE global key
(`identity_prompts.<kind>`) and both editing surfaces ignored the subject type —
so on an Animal dataset the box showed the HUMAN lock, his animal rewrite was
saved globally, and it then rode ahead of every human generation.

These tests go through the REAL config file and the REAL wrappers (no mocked
cfg.get) so they lock the whole chain the report went through, not a helper.
"""
import pytest

from app.services import face_variations as fv


@pytest.fixture(autouse=True)
def _reset_config_cache():
    """load_config() caches on a module global not keyed on LDS_CONFIG."""
    import app.config as _cfg
    _cfg._cache = None
    yield
    _cfg._cache = None


ANIMAL_TEXT = ('This is the SAME dog as the reference. Keep its breed, coat pattern '
               'and ear shape. Four legs, a tail, no shoes.')


def _put_animal_override(client):
    """Exactly what the ✎ modal / Settings card now sends from an Animal context."""
    r = client.put('/api/settings', json={'config': {'identity_prompts': {
        'by_subject': {'animal': {'face_single': ANIMAL_TEXT,
                                  'face_multi': ANIMAL_TEXT,
                                  'klein_identity': ANIMAL_TEXT}}}}})
    assert r.status_code == 200
    return r.get_json()['config']['identity_prompts']


# --- THE reported scenario ---------------------------------------------------

def test_animal_override_never_reaches_a_human_dataset(app, client):
    """Override written in an ANIMAL context -> a HUMAN dataset still gets the
    HUMAN lock, byte-identical. This is the test that matters."""
    with app.app_context():
        _put_animal_override(client)

        # the animal dataset gets what he wrote
        assert fv.get_identity_prompt('face_single', 'animal') == ANIMAL_TEXT
        assert fv.wrap_variation('a full body shot', subject_type='animal').startswith(ANIMAL_TEXT)

        # ...and the human dataset is untouched, down to the byte
        assert fv.get_identity_prompt('face_single', 'human') == fv.IDENTITY_GUARD
        assert fv.get_identity_prompt('face_multi', 'human') == fv.IDENTITY_GUARD_MULTI
        assert fv.get_identity_prompt('klein_identity', 'human') == fv.IDENTITY_GUARD_KLEIN
        human = fv.wrap_variation('a portrait')
        assert human == f'{fv.IDENTITY_GUARD} a portrait'
        assert 'tail' not in human and 'breed' not in human
        assert ANIMAL_TEXT not in fv.wrap_variation_klein('a portrait', framing='face')

        # every other subject keeps its own default too — the leak was not
        # animal->human only, it was one text for all five.
        for st in ('creature', 'object', 'other'):
            assert fv.get_identity_prompt('face_single', st) == fv.identity_prompt_default(
                'face_single', st)


# --- compatibility: an override written BEFORE this fix ----------------------

def test_legacy_flat_override_still_applies_to_human(app, client):
    """The pre-fix global key is read as the HUMAN override — where it was written
    in practice (the editor only ever showed human text). No migration, nothing
    silently dropped."""
    with app.app_context():
        r = client.put('/api/settings', json={'config': {'identity_prompts': {
            'face_single': 'MY OWN HUMAN LOCK.'}}})
        assert r.status_code == 200
        assert fv.get_identity_prompt('face_single', 'human') == 'MY OWN HUMAN LOCK.'
        assert fv.wrap_variation('a portrait') == 'MY OWN HUMAN LOCK. a portrait'
        # ...and it does NOT bleed into the other subjects any more
        assert fv.get_identity_prompt('face_single', 'animal') == fv.IDENTITY_GUARD_ANIMAL


def test_human_and_animal_overrides_coexist(app, client):
    with app.app_context():
        client.put('/api/settings', json={'config': {'identity_prompts': {
            'face_single': 'HUMAN LOCK.'}}})
        _put_animal_override(client)
        stored = client.get('/api/settings').get_json()['config']['identity_prompts']
        # the animal save deep-merges: it must not have wiped the human key
        assert stored['face_single'] == 'HUMAN LOCK.'
        assert stored['by_subject']['animal']['face_single'] == ANIMAL_TEXT
        assert fv.get_identity_prompt('face_single', 'human') == 'HUMAN LOCK.'
        assert fv.get_identity_prompt('face_single', 'animal') == ANIMAL_TEXT


def test_blank_per_subject_override_falls_back_to_that_subject_default(app, client):
    """Reset-to-default on an animal box stores '' — and '' means the ANIMAL
    default, never the human one and never the human override."""
    with app.app_context():
        client.put('/api/settings', json={'config': {'identity_prompts': {
            'face_single': 'HUMAN LOCK.',
            'by_subject': {'animal': {'face_single': '   '}}}}})
        assert fv.get_identity_prompt('face_single', 'animal') == fv.IDENTITY_GUARD_ANIMAL


# --- settings payload feeds the subject-aware editors ------------------------

def test_settings_payload_carries_defaults_for_every_subject(client):
    d = client.get('/api/settings').get_json()
    # the historical key is unchanged (human), so an older client keeps working
    assert d['identity_prompt_defaults']['face_single'] == fv.IDENTITY_GUARD
    by = d['identity_prompt_defaults_by_subject']
    assert set(by) == set(fv.SUBJECT_TYPES)
    assert by['human']['face_single'] == fv.IDENTITY_GUARD
    assert by['animal']['face_single'] == fv.IDENTITY_GUARD_ANIMAL
    assert by['object']['klein_identity'] == fv.IDENTITY_GUARD_OBJECT_KLEIN
    # klein_improve is subject-agnostic: same text in every set
    assert {t['klein_improve'] for t in by.values()} == {fv.KLEIN_IMAGE_IMPROVE_PROMPT}
