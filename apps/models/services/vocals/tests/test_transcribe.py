"""Transcribing a sung take by note count: the N strongest note starts (onsets and pitch changes) of the section.

Synthetic vocals: sine tones with silences between them, and one legato pitch change (no silence) that only the
pitch-change term of the onset envelope can find.
"""
import numpy as np
import pytest

from pipeline import music, transcribe

SR = 44100
BPM = 120  # a 16th is 0.125 s
S16 = 0.125
# (start_16th, length_16ths, sung midi, gap before the next note?)
NOTES = [(0, 2, 69, True), (2, 2, 72, True), (6, 4, 74, True), (12, 2, 76, False), (14, 2, 71, True), (20, 6, 67, True)]


def synth(notes, total_16ths=32, s16=S16, offset_s=0.0):
    n = int((offset_s + total_16ths * s16) * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    phase = 0.0
    for s, ln, m, gap in notes:
        a = int((offset_s + s * s16) * SR)
        b = int((offset_s + (s + ln) * s16) * SR) - (int(0.03 * SR) if gap else 0)
        f = 440 * 2 ** ((m - 69) / 12)
        # continuous phase, so a legato pitch change has no click (no energy onset)
        y[a:b] = 0.3 * np.sin(phase + 2 * np.pi * f * (t[a:b] - t[a]))
        phase = phase + 2 * np.pi * f * (t[b - 1] - t[a] + 1 / SR) if not gap else 0.0
        ramp = int(0.005 * SR)
        if s == 0 or notes[[x[0] for x in notes].index(s) - 1][3]:
            y[a:a + ramp] *= np.linspace(0, 1, ramp)
        if gap:
            y[b - ramp:b] *= np.linspace(1, 0, ramp)
    return np.stack([y, y])


@pytest.fixture(scope="module")
def tracker():
    return transcribe.PitchTracker()


def seg(vocal, n, tracker, octave=12, section_beats=16, clock=None):
    return transcribe.segment(vocal, SR, n, BPM, key="C", octave=octave, section="verse1", tracker=tracker,
                              section_beats=section_beats, clock=clock)


def test_n_starts_within_30_ms_with_exact_pitches(tracker):
    out = seg(synth(NOTES), len(NOTES), tracker)
    assert len(out) == len(NOTES)
    for o, (s, _, _, _) in zip(out, NOTES):
        assert abs(o["start_s"] - s * S16) <= 0.03, (o, s)
    assert [o["start"] for o in out] == [s / 4 for s, _, _, _ in NOTES]
    assert [o["midi"] for o in out] == [m - 12 for _, _, m, _ in NOTES]


def test_durations_end_where_singing_stops(tracker):
    out = seg(synth(NOTES), len(NOTES), tracker)
    assert [o["duration"] for o in out] == [ln / 4 for _, ln, _, _ in NOTES]


def test_returned_pitch_is_sung_minus_octave(tracker):
    v = synth(NOTES)
    assert [o["midi"] for o in seg(v, len(NOTES), tracker, octave=0)] == [m for _, _, m, _ in NOTES]
    assert [o["midi"] for o in seg(v, len(NOTES), tracker, octave=-12)] == [m + 12 for _, _, m, _ in NOTES]


def test_bad_octave_is_an_error(tracker):
    with pytest.raises(ValueError, match="octave 24"):
        seg(synth(NOTES), len(NOTES), tracker, octave=24)


def test_one_start_more_than_the_take_holds(tracker):
    with pytest.raises(transcribe.TranscribeError, match="verse1: found 6 of 7 note starts"):
        seg(synth(NOTES), len(NOTES) + 1, tracker)


def test_off_key_pitch_snaps_to_the_scale(tracker):
    notes = [(0, 4, 70, True), (4, 4, 73, True)]  # A#4, C#5 in C major -> A4 (down on a tie), C5
    assert [o["midi"] for o in seg(synth(notes), 2, tracker, octave=0)] == [69, 72]


def test_starts_only_inside_the_section_and_the_last_note_cut_at_its_end(tracker):
    # a section of 5.5 beats: the 6th note (beat 5) starts inside and is held on into the tail
    out = seg(synth(NOTES), len(NOTES), tracker, section_beats=5.5)
    assert (out[-1]["start"], out[-1]["duration"]) == (5.0, 0.5)
    with pytest.raises(transcribe.TranscribeError, match="found 5 of 6"):
        seg(synth(NOTES), len(NOTES), tracker, section_beats=4.5)


def test_a_take_off_our_grid_is_read_through_its_clock(tracker):
    # the take starts 1 s late and sings at half speed: take second t is our beat (t - 1)
    slow = [(2 * s, 2 * ln, m, gap) for s, ln, m, gap in NOTES]
    clock = music.Clock([1.0, 21.0], [0.0, 20.0])
    out = seg(synth(slow, total_16ths=64, offset_s=1.0), len(NOTES), tracker, clock=clock)
    assert [o["start"] for o in out] == [s / 4 for s, _, _, _ in NOTES]
    assert [o["midi"] for o in out] == [m - 12 for _, _, m, _ in NOTES]


def test_starts_a_16th_apart_on_half_16ths_never_share_a_16th():
    # 16ths 1.5 and 2.5 both round to 2 (round half to even): only one of them can be a start
    beats = np.zeros(40)
    beats[10], beats[20], beats[30] = 1.5 / 4, 2.5 / 4, 4 / 4  # frames 100 ms apart
    assert transcribe.pick_starts([10, 20, 30], beats, 3) == [10, 30]
    assert transcribe.pick_starts([20, 10, 30], beats, 3) == [20, 30]


def test_starts_closer_than_the_minimum_gap_are_not_both_taken():
    beats = np.arange(20) / 4  # a 16th per frame (10 ms): distinct 16ths but under MIN_GAP_S apart
    assert transcribe.pick_starts([0, 5, 8, 10], beats, 4) == [0, 10]


def test_octave_slips_are_corrected_and_genuine_leaps_kept():
    assert transcribe.fix_octave_slips([67, 69, 57, 71, 72]) == [67, 69, 69, 71, 72]
    assert transcribe.fix_octave_slips([60, 60, 67, 60, 60]) == [60, 60, 67, 60, 60]  # a leap of 7: kept
    assert transcribe.fix_octave_slips([60, 62, 60, 84, 62, 60, 62]) == [60, 62, 60, 60, 62, 60, 62]  # two octaves high
    assert transcribe.fix_octave_slips([70]) == [70]


def test_a_note_sung_an_octave_low_comes_back(tracker):
    notes = [(0, 2, 69, True), (2, 2, 71, True), (4, 2, 57, True), (6, 2, 72, True), (8, 2, 74, True)]
    out = seg(synth(notes), 5, tracker, octave=0)
    assert [o["midi"] for o in out] == [69, 71, 69, 72, 74]


# ---- the standalone stage (Transcribe melody: the user's own recording of one section) ------------------------------

import base64
import io
import json

import soundfile as sf


class FakeJob:
    def __init__(self):
        self.steps = []

    def check_cancelled(self):
        pass

    def step(self, id, label):
        job = self

        class S:
            def done(self, text="", numbers=None, files=None):
                job.steps.append({"id": id, "state": "done", "numbers": numbers or {}, "files": list(files or [])})

            def fail(self, text):
                job.steps.append({"id": id, "state": "failed", "text": text})

        return S()


def wav_b64(stereo, sr=SR):
    buf = io.BytesIO()
    sf.write(buf, stereo.T, sr, format="WAV")
    return base64.b64encode(buf.getvalue()).decode()


def stage_params(**over):
    p = {"stage": "transcribe", "section": "verse1", "bpm": BPM, "key": "C", "octave": 12, "section_beats": 16,
         "count": len(NOTES), "has_backing": False, "audio": wav_b64(synth(NOTES))}
    p.update(over)
    return p


def test_stage_transcribes_a_clean_recording_by_note_count(tmp_path):
    job = FakeJob()
    res = transcribe.run(stage_params(), str(tmp_path), job)
    assert res == {"file": str(tmp_path / "transcribe.json"), "kind": "json"}
    out = json.loads((tmp_path / "transcribe.json").read_text())
    assert out["section"] == "verse1" and out["voice"] == "verse1_recording.wav"
    assert [(n["start"], n["duration"], n["midi"]) for n in out["notes"]] == [(s / 4, ln / 4, m - 12) for s, ln, m, _ in NOTES]
    assert [s["id"] for s in job.steps] == ["recording:verse1", "transcribe:verse1"]  # no separation asked for
    assert job.steps[0]["files"] == ["verse1_recording.wav"] and (tmp_path / "verse1_recording.wav").exists()
    assert job.steps[1]["numbers"] == {"notes": len(NOTES)} and job.steps[1]["files"] == ["verse1_melody.json"]


def test_stage_without_a_count_only_prepares_the_voice(tmp_path):
    job = FakeJob()
    transcribe.run(stage_params(count=None), str(tmp_path), job)
    out = json.loads((tmp_path / "transcribe.json").read_text())
    assert out == {"section": "verse1", "voice": "verse1_recording.wav", "notes": None}
    assert [s["id"] for s in job.steps] == ["recording:verse1"]


def test_stage_with_backing_separates_first(tmp_path, monkeypatch):
    calls = []

    def separate_voice(audio, sr, out, section, job):
        calls.append((audio.shape, sr))
        st = job.step(f"separate:{section}", "Separate")
        sf.write(out / f"{section}_recording_vocals.wav", audio.T, sr)
        st.done("", {}, [f"{section}_recording_vocals.wav"])
        return audio, sr, f"{section}_recording_vocals.wav"

    monkeypatch.setattr(transcribe, "separate_voice", separate_voice)
    job = FakeJob()
    transcribe.run(stage_params(has_backing=True), str(tmp_path), job)
    out = json.loads((tmp_path / "transcribe.json").read_text())
    assert out["voice"] == "verse1_recording_vocals.wav" and len(out["notes"]) == len(NOTES)
    assert [s["id"] for s in job.steps] == ["recording:verse1", "separate:verse1", "transcribe:verse1"]
    assert len(calls) == 1


def test_stage_names_a_missing_param_and_a_short_recording(tmp_path):
    p = stage_params()
    del p["has_backing"]
    with pytest.raises(ValueError, match="transcribe: missing param 'has_backing'"):
        transcribe.run(p, str(tmp_path), FakeJob())
    with pytest.raises(transcribe.TranscribeError, match="verse1: found 6 of 7 note starts"):
        transcribe.run(stage_params(count=len(NOTES) + 1), str(tmp_path), FakeJob())
