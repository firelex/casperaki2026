"""The de-reverb step's model wrapper (pipeline/dereverb.py): anvuew's room-reverb BS-RoFormer, mono."""
import numpy as np
import pytest

from pipeline import dereverb


def test_the_room_model_is_configured_mono_and_returns_the_dry_stem():
    cfg = dereverb.load_config()
    assert cfg.model.stereo is False and cfg.audio.num_channels == 1
    assert cfg.training.target_instrument == "noreverb"


def test_dereverb_keeps_the_length(monkeypatch):
    class Model:
        pass

    def demix(config, model, mix, device, model_type):
        assert mix.shape[0] == 1 and model_type == "bs_roformer"
        return {"noreverb": mix * 0.25}

    monkeypatch.setattr(dereverb, "_load_model", lambda cfg, device: Model())
    monkeypatch.setattr(dereverb, "_demix", lambda: demix)
    y = np.random.default_rng(0).standard_normal(44100 * 3).astype(np.float32)
    out = dereverb.dereverb(y, 44100, "cpu")
    assert out.shape == y.shape and out.dtype == np.float32
    np.testing.assert_allclose(out, y * 0.25, rtol=1e-6)


def test_dereverb_refuses_another_rate():
    with pytest.raises(ValueError, match="44100"):
        dereverb.dereverb(np.zeros(100, np.float32), 48000, "cpu")
