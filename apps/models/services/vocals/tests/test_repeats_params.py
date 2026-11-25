"""The repeats stage's params (pipeline.repeats.check_params), the lead job's files, and the extension take."""
import json

import numpy as np
import pytest

from pipeline import repeats


def sung(start, word="la"):
    return {"start": start, "duration": 1, "midi": 60, "word": word, "phonemes": ["l", "aa1"]}


@pytest.fixture
def jobs(tmp_path):
    lead = tmp_path / "leadjob"
    lead.mkdir()
    for f in ("verse1_section.wav", "chorus1_section.wav", "verse3_ext_section.wav"):
        (lead / f).write_bytes(b"")
    out = tmp_path / "repeatsjob"
    out.mkdir()
    return out


def params(**over):
    p = {"lead_job": "leadjob", "bpm": 128, "octave": 12, "style": "EDM, female lead vocal",
         "copies": [{"segment": "verse2", "from": "verse1", "section_bars": 8, "notes": [sung(0)], "voice": "verse1_section.wav"}],
         "backings": [{"track": "Backing vocals 1", "segment": "chorus1", "section_bars": 8, "notes": [sung(1)],
                       "voice": "chorus1_section.wav"}],
         "extensions": [{"segment": "verse3", "unit": "verse3_ext", "from_bar": 8, "section_bars": 12}],
         "adlibs": None,
         "levels": {"reference": "chorus1_section.wav", "backing_db": -6, "adlib_db": -4}}
    p.update(over)
    return p


def test_valid_params_resolve_the_lead_jobs_files(jobs):
    p = repeats.check_params(params(), jobs)
    assert p["lead_dir"] == jobs.parent / "leadjob"
    assert p["copies"][0]["voice_path"] == jobs.parent / "leadjob" / "verse1_section.wav"
    assert p["reference_path"] == jobs.parent / "leadjob" / "chorus1_section.wav"


@pytest.mark.parametrize("missing", ["lead_job", "bpm", "octave", "style", "copies", "backings", "extensions", "adlibs", "levels"])
def test_a_missing_param_is_named(jobs, missing):
    p = params()
    del p[missing]
    with pytest.raises(ValueError, match=f"repeats: missing param '{missing}'"):
        repeats.check_params(p, jobs)


def test_a_missing_lead_job_is_named(jobs):
    with pytest.raises(FileNotFoundError, match="repeats: the lead job 'nojob'"):
        repeats.check_params(params(lead_job="nojob"), jobs)


def test_a_missing_voice_file_is_named(jobs):
    bad = params()
    bad["copies"][0]["voice"] = "verse9_section.wav"
    with pytest.raises(FileNotFoundError, match="copy verse2: voice file .*verse9_section.wav"):
        repeats.check_params(bad, jobs)


def test_an_item_without_notes_or_phonemes_is_an_error(jobs):
    bad = params()
    bad["backings"][0]["notes"] = []
    with pytest.raises(ValueError, match="backing Backing vocals 1 chorus1: no notes"):
        repeats.check_params(bad, jobs)
    bad = params()
    del bad["copies"][0]["notes"][0]["phonemes"]
    with pytest.raises(ValueError, match="copy verse2: note 1 lacks 'phonemes'"):
        repeats.check_params(bad, jobs)


def test_a_bad_octave_is_an_error(jobs):
    with pytest.raises(ValueError, match="octave 7"):
        repeats.check_params(params(octave=7), jobs)


def test_adlibs_need_their_keys(jobs):
    with pytest.raises(ValueError, match="repeats: adlibs is missing 'gaps_bars'"):
        repeats.check_params(params(adlibs={"chorus_unit": "chorus1", "lead_in_chords": ["C"] * 8, "chords": ["C"] * 32,
                                            "tail_chords": ["C"] * 8, "melody": [sung(0)], "segments": ["chorus4"],
                                            "seeds": 2, "threshold": 0.7}), jobs)


def test_the_extension_take_starts_at_the_section_start():
    sr, bar_s = 100, 2.0
    section = np.ones((int(4 * bar_s * sr), 2))
    take = repeats.extension_take(section, sr, from_bar=8, section_bars=12, bar_s=bar_s)
    assert len(take) == int(12 * bar_s * sr)
    assert np.all(take[: int(8 * bar_s * sr)] == 0)
    assert np.all(take[int(8 * bar_s * sr):] == 1)


def test_items_name_the_sections_bar_count_section_bars(jobs):
    bad = params()
    bad["copies"][0]["bars"] = bad["copies"][0].pop("section_bars")
    with pytest.raises(ValueError, match="copy verse2: missing 'section_bars'"):
        repeats.check_params(bad, jobs)
