"""Ad-libs (pipeline.adlibs): the ad-lib score (notes only in the gaps of the chorus lead), the YuE2 unit it makes,
and the gate that keeps only the gap bars of the sung take."""
import numpy as np
import pytest

from pipeline import adlibs

SR = 1000
BAR_S = 1.875  # 128 bpm


def test_gating_bars_3_and_7_leaves_silence_elsewhere_and_fades():
    take = np.ones((int(8 * BAR_S * SR), 2))
    out = adlibs.gate(take, SR, [3, 7], BAR_S)
    f = int(adlibs.FADE_S * SR)
    a3, z3 = int(3 * BAR_S * SR), int(4 * BAR_S * SR)
    a7 = int(7 * BAR_S * SR)
    assert out.shape == take.shape
    assert np.all(out[: a3 - f] == 0)                     # before bar 4 (and its fade-in)
    assert np.all(out[z3:a7 - f] == 0)                    # between the kept bars
    assert np.all(out[a3:z3 - f] == 1)                    # bar 4 itself, up to its fade-out
    assert out[a3 - f, 0] == pytest.approx(0, abs=1e-2)   # the fade-in starts 0.15 s before the bar line
    assert out[a3 - f // 2, 0] == pytest.approx(0.5, abs=0.02)
    assert out[z3 - f // 2, 0] == pytest.approx(0.5, abs=0.02)  # the fade-out ends at the bar's end
    assert out[z3 - 1, 0] == pytest.approx(0, abs=1e-2)


def test_neighbouring_gap_bars_are_kept_as_one_stretch():
    take = np.ones((int(8 * BAR_S * SR), 2))
    out = adlibs.gate(take, SR, [3, 4], BAR_S)
    assert np.all(out[int(3 * BAR_S * SR):int(5 * BAR_S * SR) - int(adlibs.FADE_S * SR)] == 1)


def test_a_gap_at_bar_0_fades_in_over_10_ms_inside_the_bar():
    take = np.ones((int(8 * BAR_S * SR), 2))
    out = adlibs.gate(take, SR, [0], BAR_S)
    k = int(adlibs.START_FADE_S * SR)
    assert adlibs.START_FADE_S == 0.01
    assert out[0, 0] == 0
    assert 0 < out[k // 2, 0] < 1
    assert np.all(out[k:int(BAR_S * SR) - int(adlibs.FADE_S * SR)] == 1)


def test_a_bar_outside_the_take_is_an_error():
    with pytest.raises(ValueError, match="bar 9"):
        adlibs.gate(np.ones((int(8 * BAR_S * SR), 2)), SR, [8], BAR_S)


def n(start, duration, midi=67):
    return {"start": start, "duration": duration, "midi": midi, "word": "a", "phonemes": ["aa1"]}


# bar 0: busy; bar 1: a note held from beat 4 to beat 7, the next at 7; bar 3: empty
MELODY = [n(0, 1), n(1, 1), n(2, 1), n(3, 1), n(4, 3), n(7, 1), n(8, 1), n(9, 1), n(10, 1), n(11, 1)]
CHORDS = ["C"] * 4 + ["Am"] * 4 + ["F"] * 4 + ["G"] * 4


def test_the_score_sings_oh_yeah_at_the_end_of_each_gap():
    notes, lyrics = adlibs.score_notes([1, 3], CHORDS, MELODY)
    # bar 1: the gap runs from beat 4 to 7, so "oh" at 5 and "yeah" at 6; bar 3: beats 12-16, so 14 and 15
    assert [(x["start"], x["duration"]) for x in notes] == [(5, 1), (6, 1), (14, 1), (15, 1)]
    # "oh" is the chord tone nearest the lead's median (G4 = 67): Am -> 69 (A4), G -> 67; "yeah" the next tone below
    assert [x["midi"] for x in notes] == [69, 64, 67, 62]
    assert lyrics == ["oh yeah", "oh yeah"]


def test_a_bar_without_a_gap_is_an_error():
    with pytest.raises(ValueError, match="bar 1 has no gap of two beats"):
        adlibs.score_notes([0], CHORDS, MELODY)


def test_chord_tones():
    assert adlibs.chord_tones("C") == {0, 4, 7}
    assert adlibs.chord_tones("Am") == {9, 0, 4}
    assert adlibs.chord_tones("A#") == {10, 2, 5}
    assert adlibs.chord_tones("F9") == {5, 9, 0}
    assert adlibs.chord_tones("Dm7") == {2, 5, 9}
    with pytest.raises(ValueError, match="chord 'Cxyz'"):
        adlibs.chord_tones("Cxyz")


def test_the_adlib_unit_is_a_lead_unit_over_the_chorus_chords():
    p = {"chorus_unit": "chorus1", "lead_in_chords": ["G"] * 8, "chords": CHORDS, "tail_chords": ["C"] * 8,
         "melody": MELODY, "gaps_bars": [1, 3]}
    u = adlibs.unit(p)
    assert u["id"] == "chorus1_adlibs"
    assert u["chords"] == CHORDS and u["lead_in_chords"] == ["G"] * 8 and u["tail_chords"] == ["C"] * 8
    assert len(u["notes"]) == 4 and u["lyrics"] == ["oh yeah", "oh yeah"]
    from pipeline import score
    abc = score.abc(u, 128, 12)
    assert "% chorus" in abc
