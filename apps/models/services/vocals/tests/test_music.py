"""The transcribe stage's music helpers (pipeline.music): octave check, key scales, the grid clock."""
import pytest

from pipeline import music


def test_key_scales():
    assert music.scale("C") == (0, 2, 4, 5, 7, 9, 11)
    assert music.scale("Am") == (9, 11, 0, 2, 4, 5, 7)
    assert music.scale("Bb") == (10, 0, 2, 3, 5, 7, 9)
    with pytest.raises(ValueError, match="key 'H'"):
        music.scale("H")


def test_bad_octave_is_an_error():
    assert music.check_octave(-12) == -12
    with pytest.raises(ValueError, match="octave 7"):
        music.check_octave(7)


def test_grid_clock():
    clock = music.Clock.grid(120)
    assert clock.beats(1.5) == pytest.approx(3.0) and clock.seconds(3.0) == pytest.approx(1.5)


def test_clock_anchors_must_increase():
    with pytest.raises(ValueError, match="must increase"):
        music.Clock([0.0, 0.0], [0.0, 1.0])
