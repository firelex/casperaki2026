"""hum_pitch/syllables.py: repeated syllables on one pitch become notes of their own; click mode keeps one per eighth."""
import numpy as np

from hum_pitch.syllables import merge_on_grid, repitch, split_at_onsets

SR = 22050


def la_la(starts, midis, dur=0.25):
    """Sung "la"s: each a tone with a quiet gap and a short noisy attack (a new syllable), on the given pitches."""
    rng = np.random.default_rng(0)
    y = np.zeros(int((starts[-1] + 1.0) * SR), dtype=np.float32)
    for s, m in zip(starts, midis):
        i, n = int(s * SR), int(dur * SR)
        t = np.arange(n) / SR
        tone = 0.3 * np.sin(2 * np.pi * 440 * 2 ** ((m - 69) / 12) * t)
        tone[:200] += 0.2 * rng.standard_normal(200)
        y[i:i + n] += tone.astype(np.float32)
    return y


def test_four_las_on_one_pitch_split_into_four_notes_at_their_pitch():
    starts = [0.3, 0.6, 0.9, 1.2]
    y = la_la(starts, [57] * 4)
    pieces = repitch(split_at_onsets([[0.3, 1.5, 57]], y, SR), y, SR, {"tonic": 5, "scale": "major"})
    assert len(pieces) == 4
    assert [p[2] for p in pieces] == [57] * 4
    # Each cut falls in the quiet gap before its "la" (backtracked to the quietest point), not inside a "la".
    for p, s in zip(pieces[1:], starts[1:]):
        assert s - 0.06 <= p[0] <= s + 0.01


def test_click_mode_merges_pieces_on_one_eighth():
    pieces = [[1.00, 1.10, 60], [1.12, 1.30, 62], [1.30, 1.60, 64]]  # eighths of 0.3 s from beat 1 at 1.0
    assert merge_on_grid(pieces, 1.0, 100) == [[1.00, 1.30, 62], [1.30, 1.60, 64]]
