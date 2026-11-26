"""The add-singer stage (pipeline.add_singer) with its models stubbed: params, refusals, the steps in order for a
recording with words and for a "la la la" one sung in a full song, and what it writes."""
import json
import shutil
import types
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from pipeline import add_singer, soulx

SR = 44100


def recording(path: Path, parts):
    """[(seconds, midi or None)] -> a WAV of tones and silences."""
    out = []
    for s, m in parts:
        t = np.arange(int(s * SR)) / SR
        out.append(np.zeros(len(t)) if m is None else 0.2 * np.sin(2 * np.pi * 440 * 2 ** ((m - 69) / 12) * t))
    sf.write(path, np.concatenate(out).astype(np.float32), SR)
    return str(path)


SONG = [(1.5, None), (3.0, 60), (0.3, None), (3.0, 62), (2.0, None), (2.5, 64), (0.3, None), (3.0, 62), (1.0, None)]


class FakeJob:
    def __init__(self):
        self.steps = []

    def check_cancelled(self):
        pass

    def step(self, step_id, label):
        job = self

        class Step:
            def done(self, text, numbers, files):
                job.steps.append((step_id, text, files))

        return Step()


@pytest.fixture
def stubs(monkeypatch):
    """The tools, the pitch extractor, the letter recogniser and SoulX stubbed; what the tools were asked to do."""
    state = types.SimpleNamespace(la=False, calls=[], notes=None)
    calls = state.calls

    def run_tool(cmd, cwd, job, what, log):
        assert cmd[2] in ("separate", "words", "notes"), cmd  # no other tool (no Resemble Enhance)
        calls.append(cmd[2])
        if cmd[2] == "separate":
            shutil.copy(cmd[3], cmd[4])
            return json.dumps({"sample_rate": SR, "seconds": 1.0})
        if cmd[2] == "words":
            words = ["<SP>", "la", "la", "la"] if state.la else ["<SP>", "who", "says", "<SP>"]
            Path(cmd[4]).write_text(json.dumps({"words": words, "durations": [0.5, 1, 1, 1]}))
            return "{}"
        if cmd[2] == "notes":
            ref = sf.info(cmd[3])
            clip = ref.frames / ref.samplerate
            Path(cmd[5]).write_text(json.dumps({"text": ["<SP>", "who", "says", "<SP>"],
                                                "durations": [0.1, clip / 2, clip / 2 - 0.2, 0.1],
                                                "pitches": [0, 60, 62, 0], "types": [1, 2, 2, 1],
                                                "phonemes": ["<SP>", "en_HH-UW1", "en_S-EH1-Z", "<SP>"]}))
            return "{}"

    class Singer:
        sr = 24000

        def __init__(self, device, voice_audio, voice_meta):
            assert voice_audio.name == "voice.wav" and json.loads(voice_meta.read_text())[0]["phoneme"]

        def sing(self, notes, bpm, bars, section):
            beat = 60 / bpm
            y = np.zeros(int((bars * 4 * beat + 2) * self.sr), np.float32)
            for n in notes:
                a, b = int(n["start"] * beat * self.sr), int((n["start"] + n["duration"]) * beat * self.sr)
                t = np.arange(b - a) / self.sr
                y[a:b] = 0.3 * np.sin(2 * np.pi * 440 * 2 ** ((n["midi"] - 69) / 12) * t)
            state.notes = notes
            return y

        def close(self):
            pass

    def pitch_curve(ref, device):
        info = sf.info(str(ref))
        return np.full(int(info.frames / info.samplerate / 0.02), 260.0, np.float32)

    monkeypatch.setattr(add_singer, "run_tool", run_tool)
    monkeypatch.setattr(add_singer, "pitch_curve", pitch_curve)
    monkeypatch.setattr(add_singer, "_device", lambda: "cpu")
    monkeypatch.setattr(add_singer, "_release", lambda: None)
    monkeypatch.setattr(add_singer, "l_onsets", lambda y, sr: np.arange(0.0, len(y) / sr - 0.5, 0.75))
    monkeypatch.setattr(soulx, "Singer", Singer)
    return state


def test_a_recording_with_words_becomes_a_singer(tmp_path, stubs):
    upload = recording(tmp_path / "upload.mp3.wav", SONG)
    out = tmp_path / "job"
    out.mkdir()
    job = FakeJob()
    result = add_singer.run({"stage": "add_singer", "upload": upload, "separate": False, "reference": "best"}, out, job)
    assert [s for s, _, _ in job.steps] == ["decode", "silence", "reference", "pitch", "words",
                                            "notes", "test-line"]
    assert stubs.calls == ["words", "notes"]
    r = json.loads((out / "add_singer.json").read_text())
    assert result == {"file": str(out / "add_singer.json"), "kind": "json"}
    assert r["transcription"] == "words" and r["heard"] == "who says"
    ref = r["reference"]
    assert ref["choice"] == "best" and 8 <= ref["endSeconds"] - ref["startSeconds"] <= 12
    # the 1.5 s of silence in front is cut to 0.1 s, the 2 s pause to 0.4 s
    assert ref["recordingStartSeconds"] - ref["startSeconds"] > 1.0
    meta = json.loads((out / "voice.json").read_text())
    assert isinstance(meta, list) and meta[0]["text"] == "<SP> who says <SP>"
    # the test line is centred on the reference's notes (60, 62: middle 61 -> the line's middle note, 4 above its lowest)
    assert sorted({n["midi"] for n in stubs.notes})[0] == 61 - 4
    assert r["testLinePitch"]["within"] == r["testLinePitch"]["notes"] == len(add_singer.TEST_LINE)
    for f in ("voice.wav", "voice.json", "test_line.wav"):
        assert (out / f).is_file()
    assert job.steps[-1][2] == ["test_line.wav"]


def test_a_la_recording_in_a_full_song_from_the_beginning(tmp_path, stubs):
    stubs.la = True
    upload = recording(tmp_path / "song.wav", SONG)
    out = tmp_path / "job"
    out.mkdir()
    job = FakeJob()
    add_singer.run({"stage": "add_singer", "upload": upload, "separate": True, "reference": "beginning"}, out, job)
    assert [s for s, _, _ in job.steps][:3] == ["decode", "separate", "silence"]
    assert stubs.calls == ["separate", "words"]  # no note transcriber: the la notes are found here
    r = json.loads((out / "add_singer.json").read_text())
    assert r["transcription"] == "la" and r["reference"]["choice"] == "beginning"
    assert r["reference"]["startSeconds"] == pytest.approx(0.1, abs=0.03)  # the first singing, once the silence is cut
    meta = json.loads((out / "voice.json").read_text())[0]
    assert set(meta["phoneme"].split()) <= {"<SP>", "en_L-AA1"}
    assert {int(p) for p in meta["note_pitch"].split()} - {0} <= {60, 62, 64}


def test_a_recording_over_5_minutes_is_refused(tmp_path, stubs, monkeypatch):
    upload = recording(tmp_path / "long.wav", [(1.0, 60)])
    monkeypatch.setattr(add_singer, "decode", lambda path, channels: np.zeros((SR * 301, channels), np.float32))
    with pytest.raises(ValueError, match="5 min 1 s long: a singer's recording can be at most 5 min"):
        add_singer.run({"stage": "add_singer", "upload": upload, "separate": False, "reference": "best"}, tmp_path, FakeJob())


def test_a_file_that_is_not_audio_is_refused(tmp_path):
    bad = tmp_path / "notes.txt"
    bad.write_text("not audio")
    with pytest.raises(ValueError, match="could not be read as audio"):
        add_singer.decode(str(bad), 1)


@pytest.mark.parametrize("change, message", [
    ({"upload": "relative.wav"}, "not an existing absolute file path"),
    ({"separate": "yes"}, "separate must be true or false"),
    ({"reference": "middle"}, "reference must be one of"),
])
def test_bad_params_are_errors(tmp_path, change, message):
    p = {"upload": recording(tmp_path / "a.wav", [(1.0, 60)]), "separate": False, "reference": "best"}
    with pytest.raises(ValueError, match=message):
        add_singer.check_params({**p, **change})
    with pytest.raises(ValueError, match="lack 'reference'"):
        add_singer.check_params({"upload": p["upload"], "separate": False})
