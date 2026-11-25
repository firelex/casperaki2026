"""A lead unit as a YuE2 score (ABC notation, the layout YuE2 writes itself), its lyrics and its style text.

Ported from apps/models/ace-vocal-tests/other-models/yue2_abc.py and yue2_sections.py (shared tree):
L:1/16, Q:1/4=<bpm>, voices "Vocal" and "Ins" four bars per line, "% <section>" before each part, chord names in
quotes where the chord changes (flat roots: YuE2's own scores spell Bb, Eb, Db), ties with "-". The instrumental voice
is rests (YuE2 arranges the instruments itself). Every unit starts with LEAD_BARS bars of the preceding chords and no
singing ("% intro") and ends with TAIL_BARS bars of the following chords and no singing ("% outro"), so a take that
sings slower than the score has room to finish its last phrase.

Register: the brain sends notes in the Vocal lane's register and one octave shift per song (`octave`, -12/0/12); the
sung lead is lane + octave, and YuE2's ABC is an octave above sung pitch, so the ABC writes lane + octave + 12.
"""
from __future__ import annotations

import re

LEAD_BARS = 2
TAIL_BARS = 2  # the chords that follow the section, no singing: room for YuE2 to finish a phrase that runs over
UNITS_PER_BEAT = 4  # L:1/16
OCTAVES = (-12, 0, 12)
SECTION_WORD = {"intro": "intro", "verse": "verse", "prechorus": "pre-chorus", "chorus": "chorus",
                "bridge": "bridge", "break": "interlude", "outro": "outro"}
LYRIC_TAG = {"verse": "[Verse]", "pre-chorus": "[Pre-Chorus]", "chorus": "[Chorus]", "bridge": "[Bridge]",
             "outro": "[Outro]", "intro": "[Intro]", "interlude": "[Interlude]"}
NAMES = ["C", "^C", "D", "^D", "E", "F", "^F", "G", "^G", "A", "^A", "B"]
FLATS = {"C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb"}
ROOTS = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8,
         "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}
MAJOR = (0, 2, 4, 5, 7, 9, 11)
MINOR = (0, 2, 3, 5, 7, 8, 10)


def check_octave(octave) -> int:
    if octave not in OCTAVES:
        raise ValueError(f"octave {octave!r} is not one of {list(OCTAVES)}")
    return int(octave)


def parse_key(key: str) -> tuple[str, str]:
    """(root, "major" | "minor") of a key like "C", "Bb", "F#m", "A minor"."""
    m = re.fullmatch(r"([A-G][#b]?)\s*(m|min|minor|maj|major)?", key.strip()) if isinstance(key, str) else None
    if m is None or m.group(1) not in ROOTS:
        raise ValueError(f"key {key!r} is not a key like 'C', 'Bb', 'F#m' or 'A minor'")
    return m.group(1), "minor" if m.group(2) in ("m", "min", "minor") else "major"


def scale(key: str) -> tuple[int, ...]:
    """Pitch classes of the key's scale (natural minor for a minor key), starting at the root."""
    root, mode = parse_key(key)
    return tuple((ROOTS[root] + step) % 12 for step in (MINOR if mode == "minor" else MAJOR))


def abc_pitch(midi: int) -> str:
    """ABC note for a MIDI pitch (C4 = 60 = "C", c = C5, c' = C6, C, = C3); sharps for black keys (K:C)."""
    name, octave = NAMES[midi % 12], midi // 12 - 1
    acc, letter = (name[0], name[1]) if name.startswith("^") else ("", name)
    if octave >= 5:
        return acc + letter.lower() + "'" * (octave - 5)
    return acc + letter + "," * (4 - octave)


def flat_name(chord: str) -> str:
    """Chord name with a flat root (our charts say A#, D#, C#)."""
    root = chord[:2] if len(chord) > 1 and chord[1] == "#" else chord[:1]
    return FLATS.get(root, root) + chord[len(root):]


def section_word(unit_id: str) -> str:
    low = unit_id.lower()
    for prefix, word in SECTION_WORD.items():
        if low.startswith(prefix):
            return word
    raise ValueError(f"unit {unit_id!r}: no YuE2 section word (expected an id starting with one of {list(SECTION_WORD)})")


def bar_tokens(notes, chords, shift: int) -> str:
    """One bar as ABC: notes = [(start_16th, end_16th, midi, tied_on)] inside the bar (0..16), chords = chord name
    per beat. Splits notes and rests where the chord changes so each chord name sits on the token at its beat."""
    cuts = {0, 16} | {k * UNITS_PER_BEAT for k in range(1, 4) if chords[k] != chords[k - 1]}
    for s, e, _, _ in notes:
        cuts |= {s, e}
    cuts = sorted(c for c in cuts if 0 <= c <= 16)
    out = []
    for a, b in zip(cuts, cuts[1:]):
        beat = a // UNITS_PER_BEAT
        chord = f'"{chords[beat]}"' if a % UNITS_PER_BEAT == 0 and (a == 0 or chords[beat] != chords[beat - 1]) else ""
        n = next((x for x in notes if x[0] <= a < x[1]), None)
        if n is None:
            out.append(f"{chord}z{b - a}")
        else:
            out.append(f"{chord}{abc_pitch(n[2] + shift)}{b - a}" + ("-" if (b < n[1] or (b == 16 and n[3])) else ""))
    return "".join(out)


def _sixteenth(unit_id: str, beats, what: str) -> int:
    x = float(beats) * UNITS_PER_BEAT
    if abs(x - round(x)) > 1e-6:
        raise ValueError(f"{unit_id}: {what} {beats:g} is not on the 16th grid")
    return int(round(x))


def _bars(unit_id: str, chords: list, what: str) -> list[list[str]]:
    if not chords or len(chords) % 4:
        raise ValueError(f"{unit_id}: {what} has {len(chords)} beats of chords, want whole bars of 4")
    return [[flat_name(c) for c in chords[i:i + 4]] for i in range(0, len(chords), 4)]


def abc(unit: dict, bpm, octave: int) -> str:
    """The YuE2 score of a lead unit: LEAD_BARS bars of lead-in chords (no singing), then the section."""
    uid = unit["id"]
    shift = check_octave(octave) + 12
    if len(unit["lead_in_chords"]) != LEAD_BARS * 4:
        raise ValueError(f"{uid}: lead-in has {len(unit['lead_in_chords'])} beats of chords, want {LEAD_BARS * 4}")
    if len(unit["tail_chords"]) != TAIL_BARS * 4:
        raise ValueError(f"{uid}: tail has {len(unit['tail_chords'])} beats of chords, want {TAIL_BARS * 4}")
    lead = _bars(uid, unit["lead_in_chords"], "lead-in")
    tail = _bars(uid, unit["tail_chords"], "tail")
    sec = _bars(uid, unit["chords"], "section")
    end = len(sec) * 16
    notes = []
    for n in unit["notes"]:
        s = _sixteenth(uid, n["start"], "note at beat")
        e = s + _sixteenth(uid, n["duration"], f"note at beat {n['start']:g} has duration")
        if e <= s or s < 0 or e > end:
            raise ValueError(f"{uid}: note at beat {n['start']:g} (duration {n['duration']:g}) is outside the section")
        notes.append((s, e, int(n["midi"])))
    notes.sort()
    for x, y in zip(notes, notes[1:]):
        if y[0] < x[1]:
            raise ValueError(f"{uid}: overlapping notes at beat {y[0] / UNITS_PER_BEAT:g}")
    lines = ["X:1", "T:", "M:4/4", "L:1/16", f"Q:1/4={bpm:g}",
             'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"', 'V: Ins clef=treble name="Ins Melody" snm="Inst."',
             "K:C", "% intro", "V: Vocal", "".join(bar_tokens([], ch, shift) + "|" for ch in lead),
             "V: Ins", f"Z{LEAD_BARS}|", f"% {section_word(uid)}"]
    for g in range(0, len(sec), 4):
        toks = []
        for bi in range(g, min(g + 4, len(sec))):
            a, b = bi * 16, bi * 16 + 16
            inbar = [(max(s, a) - a, min(e, b) - a, p, e > b) for s, e, p in notes if s < b and e > a]
            toks.append(bar_tokens(inbar, sec[bi], shift) + "|")
        lines += ["V: Vocal", "".join(toks), "V: Ins", f"Z{len(toks)}|"]
    lines += ["% outro", "V: Vocal", "".join(bar_tokens([], ch, shift) + "|" for ch in tail), "V: Ins", f"Z{TAIL_BARS}|"]
    return "\n".join(lines) + "\n"


def lyrics_text(unit: dict) -> str:
    """The unit's lyrics in YuE2's layout: an empty [Intro] for the lead-in, the section tag and one sung phrase per
    line (each lyric line split at commas), an empty [Outro] for the tail."""
    tag = LYRIC_TAG[section_word(unit["id"])]
    phrases = [p.strip() for line in unit["lyrics"] for p in line.split(",") if p.strip()]
    if not phrases:
        raise ValueError(f"{unit['id']}: no lyrics")
    return "\n".join(["[Intro]", "", tag] + phrases + ["", "[Outro]"])
