"""The sing stage (pipeline.sing): its params, the backing line's pitch made from the lead's (pipeline.svc.target_f0),
and a whole run with the two models stubbed (steps in model order, takes at 44.1 kHz stereo, backings 9 dB under)."""
import json
import numpy as np
import pytest
import soundfile as sf

from pipeline import levels, sing, soulx, svc

BPM = 120  # a beat is 0.5 s, a bar 2 s


def sung_note(start, duration, midi, word="la"):
    return {"start": start, "duration": duration, "midi": midi, "word": word, "phonemes": ["l", "aa1"]}


def params(**over):
    p = {"bpm": BPM, "backing_db": -9,
         "sections": [{"segment": "verse1", "section_bars": 2, "notes": [sung_note(0, 2, 64), sung_note(2, 2, 67)]},
                      {"segment": "chorus1", "section_bars": 2, "notes": [sung_note(0, 4, 69)]}],
         "backings": [{"track": "Backing vocals 1", "segment": "chorus1", "notes": [{"start": 0, "duration": 4, "midi": 65}]}]}
    p.update(over)
    return p


def test_params_checked():
    p = sing.check_params(params())
    assert [x["segment"] for x in p["leads"]] == ["verse1", "chorus1"]
    assert p["backings"][0]["take"] == "take_chorus1_backing_vocals_1.wav"
    assert p["backings"][0]["lead"]["segment"] == "chorus1"
    assert p["leads"][0]["take"] == "take_verse1_vocal.wav"


def test_a_missing_param_is_an_error():
    p = params()
    del p["backing_db"]
    with pytest.raises(ValueError, match="missing 'backing_db'"):
        sing.check_params(p)


@pytest.mark.parametrize("change, message", [
    ({"sections": []}, "no sections"),
    ({"backing_db": 3}, "above the lead"),
    ({"backings": [{"track": "Backing vocals 1", "segment": "bridge1", "notes": [{"start": 0, "duration": 1, "midi": 60}]}]},
     "not among the sung sections"),
    ({"sections": [{"segment": "verse1", "section_bars": 2, "notes": [{**sung_note(0, 1, 60), "phonemes": []}]}]},
     "has no phonemes"),
])
def test_bad_params_are_errors(change, message):
    with pytest.raises(ValueError, match=message):
        sing.check_params(params(**change))


def test_target_pitch_moves_the_lead_by_the_interval_between_the_lines():
    frame_s = 0.02
    lead_f0 = np.full(200, 440.0, dtype=np.float32)  # 4 s
    lead_f0[10] = 0  # an unvoiced frame stays unvoiced
    lead = [{"start": 0, "duration": 4, "midi": 69}, {"start": 4, "duration": 2, "midi": 72}]
    backing = [{"start": 0, "duration": 2, "midi": 65}, {"start": 4, "duration": 2, "midi": 69}]
    tgt = svc.target_f0(lead_f0, frame_s, BPM, lead, backing)
    assert tgt[0] == pytest.approx(440 * 2 ** (-4 / 12))
    assert tgt[10] == 0
    assert np.all(tgt[50:100] == 0)  # beats 2-4: the backing line rests
    assert tgt[120] == pytest.approx(440 * 2 ** (-3 / 12))
    assert np.all(tgt[150:] == 0)  # after both lines


class FakeJob:
    def __init__(self):
        self.steps = []

    def check_cancelled(self):
        pass

    def step(self, step_id, label):
        job = self

        class Step:
            def done(self, text, numbers, files):
                job.steps.append((step_id, files))

        return Step()


def test_a_whole_run_with_the_models_stubbed(tmp_path, monkeypatch):
    sr = 24000

    class Singer:
        def __init__(self, device):
            self.sr = sr

        def sing(self, notes, bpm, bars, section):
            t = np.arange(int((bars * 2 + 2) * sr)) / sr
            return (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)

        def close(self):
            pass

    class Converter:
        def __init__(self, device):
            self.sr = sr

        def repitch(self, lead, lead_path, bpm, lead_notes, backing_notes, work, what):
            assert lead_path.is_file()
            return (0.8 * lead).astype(np.float32)

        def close(self):
            pass

    monkeypatch.setattr(soulx, "Singer", Singer)
    monkeypatch.setattr(svc, "Converter", Converter)
    monkeypatch.setattr(sing, "_device", lambda: "cpu")
    monkeypatch.setattr(sing, "_release", lambda: None)

    job = FakeJob()
    result = sing.run(params(), tmp_path, job)
    assert [s for s, _ in job.steps] == ["soulx:verse1", "soulx:chorus1", "harmony:Backing vocals 1:chorus1",
                                         "chain:verse1", "chain:chorus1", "chain:Backing vocals 1:chorus1", "levels"]
    out = json.loads((tmp_path / "sing.json").read_text())
    assert result == {"file": str(tmp_path / "sing.json"), "kind": "json"}
    assert [(t["segment"], t["track"], t["kind"]) for t in out["takes"]] == [
        ("verse1", "Vocal", "soulx-vocal"), ("chorus1", "Vocal", "soulx-vocal"),
        ("chorus1", "Backing vocals 1", "soulx-vocal")]
    assert job.steps[-1][1] == [t["file"] for t in out["takes"]]
    takes = {t["track"]: sf.read(tmp_path / t["file"], always_2d=True) for t in out["takes"] if t["segment"] == "chorus1"}
    for x, rate in takes.values():
        assert rate == 44100 and x.shape == (int((4.0 + levels.FADE_S) * 44100), 2)
    lead, back = takes["Vocal"][0], takes["Backing vocals 1"][0]
    assert 20 * np.log10(levels.loud(back) / levels.loud(lead)) == pytest.approx(-9, abs=0.05)
    assert sf.info(tmp_path / out["takes"][0]["file"]).subtype == "FLOAT"


def test_backing_vocals_are_panned_apart_at_the_same_loudness():
    from pipeline.sing import BACKING_PAN, panned
    x = np.repeat(np.sin(np.linspace(0, 200, 4800, dtype=np.float32))[:, None], 2, axis=1)
    left, right = panned(x, BACKING_PAN["Backing vocals 1"]), panned(x, BACKING_PAN["Backing vocals 2"])
    assert np.abs(left[:, 0]).max() > np.abs(left[:, 1]).max()  # Backing vocals 1 to the left
    assert np.abs(right[:, 1]).max() > np.abs(right[:, 0]).max()  # Backing vocals 2 to the right
    power = lambda y: float((y ** 2).sum())
    assert abs(power(left) - power(x)) / power(x) < 1e-5  # equal power: as loud as centred
    assert np.allclose(panned(x, 0.0), x, atol=1e-6)
