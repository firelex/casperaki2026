"""The YuE2 score (ABC) for a lead unit: layout of other-models/yue2_sections.py, octave shift from the brain."""
import json
from pathlib import Path

import pytest

from pipeline import score

SONG = Path("/home/roli79/casperaki-data/renders/a31c5ba00357d922/brain-song.json")

# First two Vocal lines of /mnt/d/casperaki-models/vocal-model-tests/yue2/female_s831001/verse1.abc (song a31c5ba0,
# octave +12: lane + 24 in the ABC).
LEAD_IN = '"G"z16|"Dm"z16|'
VERSE_LINE_OCT12 = '"C"g2g2g2c\'1c\'1c\'2g1g5|"Bb"g2g2g2g1g1a2c\'1c\'3c\'1c\'1-|"Am"c\'2c\'2z10g1a1-|"F9"a2g2z12|'
VERSE_LINE_OCT0 = '"C"G2G2G2c1c1c2G1G5|"Bb"G2G2G2G1G1A2c1c3c1c1-|"Am"c2c2z10G1A1-|"F9"A2G2z12|'
VERSE_LINE_OCTM12 = '"C"G,2G,2G,2C1C1C2G,1G,5|"Bb"G,2G,2G,2G,1G,1A,2C1C3C1C1-|"Am"C2C2z10G,1A,1-|"F9"A,2G,2z12|'


def verse1_unit():
    """The lead unit the brain sends for a31c5ba0's verse1 (lane-register notes, chords per beat)."""
    song = json.loads(SONG.read_text())
    sections = {s["name"]: s for s in song["songStructure"]}
    intro, verse = sections["intro"], sections["verse1"]
    notes = []
    for bi, bar in enumerate(song["arrangement"]["verse1"]["overrides"]["Vocal"]["bars"]):
        for pos, ns in bar.get("notes", {}).items():
            for n in ns:
                notes.append({"start": bi * 4 + float(pos), "duration": n["duration"], "midi": n["note"]})
    return {
        "id": "verse1",
        "lead_in_chords": [c for b in intro["bars"][-2:] for c in b["chords"]],
        "tail_chords": [c for b in sections["verse2"]["bars"][:2] for c in b["chords"]],
        "chords": [c for b in verse["bars"] for c in b["chords"]],
        "notes": sorted(notes, key=lambda n: n["start"]),
        "lyrics": ["Streetlights flicker on the corner, I can feel the city calling, out to me, out to me",
                   "Every window shining golden, I've been waiting for the weekend, here it comes, here it comes"],
    }


def vocal_lines(abc):
    lines = abc.splitlines()
    return [lines[i + 1] for i, x in enumerate(lines) if x == "V: Vocal"]


def test_header_and_sections():
    abc = score.abc(verse1_unit(), 128, 12)
    lines = abc.splitlines()
    assert lines[:8] == ["X:1", "T:", "M:4/4", "L:1/16", "Q:1/4=128",
                         'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"',
                         'V: Ins clef=treble name="Ins Melody" snm="Inst."', "K:C"]
    assert lines[8] == "% intro" and "% verse" in lines
    assert lines.count("V: Ins") == 4 and lines.count("Z2|") == 2 and lines.count("Z4|") == 2


def test_octave_12_matches_the_experiment_score():
    assert vocal_lines(score.abc(verse1_unit(), 128, 12))[:2] == [LEAD_IN, VERSE_LINE_OCT12]


def test_octave_0():
    assert vocal_lines(score.abc(verse1_unit(), 128, 0))[:2] == [LEAD_IN, VERSE_LINE_OCT0]


def test_octave_minus_12():
    assert vocal_lines(score.abc(verse1_unit(), 128, -12))[:2] == [LEAD_IN, VERSE_LINE_OCTM12]


def test_bad_octave_is_an_error():
    with pytest.raises(ValueError, match="octave 7"):
        score.abc(verse1_unit(), 128, 7)


def test_lead_in_must_be_two_bars():
    unit = verse1_unit()
    unit["lead_in_chords"] = unit["lead_in_chords"][:4]
    with pytest.raises(ValueError, match="verse1: lead-in has 4 beats of chords, want 8"):
        score.abc(unit, 128, 12)


def test_notes_off_the_16th_grid_are_an_error():
    unit = verse1_unit()
    unit["notes"][0]["start"] = 0.1
    with pytest.raises(ValueError, match="verse1: note at beat 0.1 is not on the 16th grid"):
        score.abc(unit, 128, 12)


def test_lyrics_in_yue2_layout():
    assert score.lyrics_text(verse1_unit()) == (
        "[Intro]\n\n[Verse]\nStreetlights flicker on the corner\nI can feel the city calling\nout to me\nout to me\n"
        "Every window shining golden\nI've been waiting for the weekend\nhere it comes\nhere it comes\n\n[Outro]")


def test_style_and_key():
    assert score.style(128, "C") == ("EDM, dance pop, energetic, female lead vocal, synthesizer, drum machine, "
                                     "synth bass, 128 bpm, C major")
    assert score.scale("C") == (0, 2, 4, 5, 7, 9, 11)
    assert score.scale("Am") == (9, 11, 0, 2, 4, 5, 7)
    assert score.scale("Bb") == (10, 0, 2, 3, 5, 7, 9)
    with pytest.raises(ValueError, match="key 'H'"):
        score.scale("H")


def test_tail_bars_after_the_section():
    lines = score.abc(verse1_unit(), 128, 12).splitlines()
    i = lines.index("% outro")
    assert lines[i:] == ["% outro", "V: Vocal", '"C"z16|"Bb"z16|', "V: Ins", "Z2|"]
    assert lines.index("% verse") < i


def test_tail_must_be_two_bars():
    unit = verse1_unit()
    unit["tail_chords"] = unit["tail_chords"] + ["C"] * 4
    with pytest.raises(ValueError, match="verse1: tail has 12 beats of chords, want 8"):
        score.abc(unit, 128, 12)
