"""Klein GENERATION steps are a setting (raised by ashish.sinha on Discord:
"is the number of generation steps fixed at 5, cant we increase them").

They were: the shipped workflow hardcodes 5 at its sampler node and the
generation call sites never passed `sampler_steps`, so the parameter
enqueue_klein_edit had been written with was unreachable. `klein.generation_steps`
now feeds it, defaulting to 5 so an untouched install renders exactly as before.

(More steps improve the RENDER. They do not fix a prompt that describes the wrong
kind of subject — that is what the per-subject identity prompts are for, see
test_identity_prompt_subject_scope.)
"""
import pytest

from app.config import LOCAL_USER


@pytest.fixture(autouse=True)
def _reset_config_cache():
    import app.config as _cfg
    _cfg._cache = None
    yield
    _cfg._cache = None


def _generate(app, monkeypatch, config_steps=None):
    """Run ONE Klein variation and return the kwargs the enqueue received."""
    from app.services import face_dataset_service as svc
    from app.services import klein_edit_helper as keh
    queued = []
    monkeypatch.setattr(keh, 'klein_missing_assets', lambda: [])
    monkeypatch.setattr(keh, 'klein_missing_nodes', lambda: [])
    monkeypatch.setattr(keh, 'enqueue_klein_edit',
                        lambda **kw: (queued.append(kw) or 'job-1'))
    monkeypatch.setattr(keh, 'resolve_generation_lora_preset', lambda _n: [])
    monkeypatch.setattr(svc, '_sync_generate_activity', lambda _d: None)
    if config_steps is not None:
        import app.config as cfg
        cfg.save_config({'klein': {'generation_steps': config_steps}})
    with app.app_context():
        ds = svc.create_dataset(LOCAL_USER, 'Steps', 'steps')
        ds.ref_filename = 'ref.png'
        svc.db.session.commit()
        svc.generate_variations(
            LOCAL_USER, ds.id,
            [{'label': 'Face · neutral', 'framing': 'face', 'prompt': 'a portrait'}],
            1, None)
    return queued


def test_default_is_the_shipped_five(app, monkeypatch):
    """Untouched install: the value passed equals the workflow's hardcoded 5, so
    the render is unchanged — but it IS passed, which is what makes it settable."""
    queued = _generate(app, monkeypatch)
    assert queued[0]['sampler_steps'] == 5


def test_configured_value_reaches_the_engine(app, monkeypatch):
    queued = _generate(app, monkeypatch, config_steps=18)
    assert queued[0]['sampler_steps'] == 18


@pytest.mark.parametrize('stored,expected', [
    (0, 1), (-4, 1), (999, 50),      # clamped to the engine's usable range
    ('nonsense', 5), (None, 5),      # a broken value degrades, never crashes
])
def test_bad_values_degrade(app, monkeypatch, stored, expected):
    queued = _generate(app, monkeypatch, config_steps=stored)
    assert queued[0]['sampler_steps'] == expected


def test_config_default_is_five():
    from app.config import DEFAULTS
    assert DEFAULTS['klein']['generation_steps'] == 5


def test_workflow_json_is_untouched():
    """The knob is passed at enqueue time; the shipped graph keeps its own 5 as the
    fallback for any caller that passes nothing."""
    import json
    from app.services.klein_edit_helper import WORKFLOW_IMPROVE_SKIN_PATH
    wf = json.loads(WORKFLOW_IMPROVE_SKIN_PATH.read_text(encoding='utf-8'))
    assert wf['77']['inputs']['steps'] == 5
