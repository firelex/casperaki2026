"""Aligning a take's ChordNet chords to the chords the unit asked for (DTW over half beats)."""
import numpy as np
import pytest

from pipeline import align

BPM = 120  # a beat is 0.5 s, a bar 2 s
BAR_S = 2.0
EXPECTED = (["G"] * 4 + ["Dm"] * 4  # lead-in
            + ["C"] * 4 + ["A#"] * 4 + ["Am"] * 4 + ["F9"] * 4 + ["C"] * 4 + ["A#"] * 4 + ["Am"] * 4 + ["F9"] * 4)
LABEL = {"G": "G:maj", "Dm": "D:min", "C": "C:maj", "A#": "Bb:maj", "Am": "A:min", "F9": "F:maj", "Em": "E:min"}


def segments(beats, beat_s=0.5):
    """ChordNet-style segments [[label, start_s, end_s]] for one chord name per beat."""
    out = []
    for i, c in enumerate(beats):
        a, b = i * beat_s, (i + 1) * beat_s
        if out and out[-1][0] == LABEL[c]:
            out[-1][2] = b
        else:
            out.append([LABEL[c], a, b])
    return out


def test_identical_take_maps_bar_to_bar():
    bar_map, match = align.align(segments(EXPECTED), EXPECTED, BPM)
    assert len(bar_map) == 10 and len(match) == 80
    for b, (s, e) in enumerate(bar_map):
        assert (s, e) == pytest.approx((b * BAR_S, (b + 1) * BAR_S))
    assert all(match)


def test_extra_intro_shifts_every_bar_two_bars_late():
    bar_map, match = align.align(segments(["Em"] * 8 + EXPECTED), EXPECTED, BPM)
    assert bar_map[0][0] == pytest.approx(2 * BAR_S)
    for b, (s, e) in enumerate(bar_map):
        assert (s, e) == pytest.approx(((b + 2) * BAR_S, (b + 3) * BAR_S))
    assert np.mean(match) == 1.0


def test_inserted_beats_shift_later_bars():
    take = EXPECTED[:24] + ["Em"] * 4 + EXPECTED[24:]  # 4 extra beats after bar 6 (lead-in + 4 section bars)
    bar_map, match = align.align(segments(take), EXPECTED, BPM)
    for b in range(6):
        assert bar_map[b] == pytest.approx((b * BAR_S, (b + 1) * BAR_S))
    for b in range(6, 10):
        assert bar_map[b] == pytest.approx((b * BAR_S + 2.0, (b + 1) * BAR_S + 2.0))
    assert all(match)


def test_section_match_counts_the_section_only():
    take = EXPECTED[:8] + ["Em"] * 8 + EXPECTED[16:]  # the first two section bars over the wrong chord
    _, match = align.align(segments(take), EXPECTED, BPM)
    assert align.section_match(match, lead_bars=2) == pytest.approx(1 - 16 / 64)


def test_unknown_chord_is_an_error():
    with pytest.raises(ValueError, match="chord 'H7'"):
        align.align(segments(EXPECTED), EXPECTED[:-1] + ["H7"], BPM)


def test_cut_bars_places_each_bar_on_our_grid():
    sr = 1000
    t = np.arange(int(12 * BAR_S * sr)) / sr
    voc = np.stack([np.sin(2 * np.pi * 5 * t)] * 2)
    bar_map = [(b * BAR_S + 1.0, (b + 1) * BAR_S + 1.0) for b in range(10)]
    bar_map[5] = None  # skipped by the take: stays silent
    out = align.cut_bars(voc, sr, bar_map, BPM, from_bar=2)
    assert out.shape == (2, int(8 * BAR_S * sr))
    seg = slice(int(3 * BAR_S * sr), int(4 * BAR_S * sr))
    assert np.all(out[:, seg] == 0)
    assert np.abs(out[:, : int(BAR_S * sr)]).max() > 0.5


def test_a_dragged_out_bar_is_unusable_and_off_our_chords():
    take = EXPECTED[:20] + ["F9"] * 12 + EXPECTED[24:]  # bar 5 (F9) held for three bars
    bar_map, match = align.align(segments(take), EXPECTED, BPM)
    assert bar_map[5] is None and not any(match[40:48])
    assert bar_map[6] == pytest.approx((16.0, 18.0))


def test_the_last_bar_ends_one_bar_after_its_start():
    bar_map, _ = align.align(segments(EXPECTED + ["F9"] * 8), EXPECTED, BPM)
    assert bar_map[-1] == pytest.approx((18.0, 20.0))


def test_take_clock_maps_take_seconds_to_our_beats():
    bar_map = [(0.0, 2.0), (2.0, 4.0), (5.0, 7.0), (7.0, 10.0), None, (12.0, 14.0)]  # 1 s added before bar 2
    clock = align.take_clock(bar_map, from_bar=2)
    assert clock.beats(5.0) == pytest.approx(0.0)
    assert clock.beats(6.0) == pytest.approx(2.0)
    assert clock.beats(9.5) == pytest.approx(8.0)  # bar 3 (5 s with the bar it skipped) spans beats 4..12
    assert clock.beats(13.0) == pytest.approx(14.0)
    assert clock.seconds(4.0) == pytest.approx(7.0)
    assert np.allclose(clock.beats(np.array([5.0, 7.0])), [0.0, 4.0])


def test_grid_clock():
    clock = align.Clock.grid(120)
    assert clock.beats(1.5) == pytest.approx(3.0) and clock.seconds(3.0) == pytest.approx(1.5)
