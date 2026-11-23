"""Shared music helpers for the AMT spike: chord parsing, precedent notes, bar maths.

A "note" here is a dict {"beat": float, "dur": float, "midi": int} with beats counted
from the start of bar 1 (4 beats per bar).
"""

import re

PITCH_CLASS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# chord suffix -> intervals above the root
CHORD_INTERVALS = {
    "": (0, 4, 7),
    "m": (0, 3, 7),
    "7": (0, 4, 7, 10),
    "m7": (0, 3, 7, 10),
    "maj7": (0, 4, 7, 11),
    "maj9": (0, 4, 7, 11, 14),
    "9": (0, 4, 7, 10, 14),
    "m9": (0, 3, 7, 10, 14),
    "sus": (0, 5, 7),
    "sus4": (0, 5, 7),
    "sus2": (0, 2, 7),
}

BEATS_PER_BAR = 4


def pitch_class(name):
    m = re.fullmatch(r"([A-G])([#b]?)", name)
    if not m:
        raise ValueError(f"not a pitch name: {name!r}")
    pc = PITCH_CLASS[m.group(1)]
    if m.group(2) == "#":
        pc += 1
    elif m.group(2) == "b":
        pc -= 1
    return pc % 12


def parse_chord(symbol):
    """Return (root pitch class, tuple of chord-tone pitch classes)."""
    m = re.fullmatch(r"([A-G][#b]?)(.*)", symbol)
    if not m:
        raise ValueError(f"cannot parse chord {symbol!r}")
    root = pitch_class(m.group(1))
    suffix = m.group(2)
    if suffix not in CHORD_INTERVALS:
        raise ValueError(f"unknown chord suffix {suffix!r} in {symbol!r}")
    return root, tuple(sorted({(root + i) % 12 for i in CHORD_INTERVALS[suffix]}))


def signed_shift_to(key_name):
    """Semitone shift that moves C to key_name, within -6..+5."""
    pc = pitch_class(key_name)
    return pc - 12 if pc > 5 else pc


def precedent_notes(precedent, shift):
    """Melody of a precedent as note dicts, transposed by shift and moved by whole octaves
    so its median pitch lies in 60..71 (a normal sung range; the banks' octaves vary)."""
    notes = []
    for beat_key, entries in precedent["melody"].items():
        for e in entries:
            notes.append({"beat": float(beat_key), "dur": float(e["duration"]), "midi": int(e["midi"]) + shift})
    if not notes:
        raise ValueError(f"precedent {precedent['properties']['name']!r} has no melody notes")
    pitches = sorted(n["midi"] for n in notes)
    median = pitches[len(pitches) // 2]
    octave = 12 * ((60 - median) // 12 + (1 if (60 - median) % 12 else 0))
    for n in notes:
        n["midi"] += octave
    notes.sort(key=lambda n: (n["beat"], n["midi"]))
    return notes


def precedent_chords(precedent, shift, n_bars):
    """Chord per beat (list of n_bars*4 symbols' parsed (root, tones)) plus the bar chord list."""
    chords = precedent["chords"]
    per_beat = []
    for b in range(n_bars * BEATS_PER_BAR):
        key = f"{b}.0"
        if key not in chords:
            raise ValueError(f"precedent {precedent['properties']['name']!r} has no chord at beat {key}")
        root, tones = parse_chord(chords[key]["chord"])
        per_beat.append(((root + shift) % 12, tuple(sorted((t + shift) % 12 for t in tones))))
    return per_beat


def chord_spans(per_beat):
    """Merge per-beat chords into spans: list of (start_beat, end_beat, root, tones)."""
    spans = []
    for b, (root, tones) in enumerate(per_beat):
        if spans and spans[-1][2] == root and spans[-1][3] == tones:
            spans[-1] = (spans[-1][0], b + 1, root, tones)
        else:
            spans.append((b, b + 1, root, tones))
    return spans


def block_chord_pitches(root, tones):
    """Voicing for the block-chord accompaniment: root in the bass (octave 3), chord tones in octave 4."""
    return [48 + root] + [60 + t for t in tones]


def bar_of(beat):
    return int(beat // BEATS_PER_BAR)
