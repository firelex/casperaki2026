"""Keys the generator stored with a clip (rounds two and three): parse and label them."""
NOTE_NAMES = {"C": 0, "C#": 1, "DB": 1, "D": 2, "D#": 3, "EB": 3, "E": 4, "F": 5, "F#": 6, "GB": 6, "G": 7, "G#": 8, "AB": 8,
              "A": 9, "A#": 10, "BB": 10, "B": 11}
MAJOR_LIKE = {"major", "ionian", "lydian", "mixolydian", "major_pentatonic"}
MINOR_LIKE = {"minor", "aeolian", "natural_minor", "harmonic_minor", "melodic_minor", "dorian", "phrygian", "minor_pentatonic"}


def stored_key(m: dict) -> int | None:
    """The key the generator stored for a clip, as 0-23 (tonic + 12 for minor-like scales), or None when the clip has
    no stored key. Looks at a top-level "key" object or score.key, with "tonic" (0-11 or a note name) and "mode" or
    "scale". A key object that cannot be read is an error."""
    k = m.get("key")
    if k is None and isinstance(m.get("score"), dict):
        k = m["score"].get("key")
    if k is None:
        return None
    if not isinstance(k, dict) or "tonic" not in k or not ({"mode", "scale"} & set(k)):
        raise ValueError(f"{m.get('clip_id')}: unreadable stored key {k!r}")
    t = k["tonic"]
    tonic = int(t) % 12 if isinstance(t, (int, float)) else NOTE_NAMES[str(t).strip().upper()]
    mode = str(k["mode"] if "mode" in k else k["scale"]).lower().strip().replace(" ", "_").replace("-", "_")
    if mode in MAJOR_LIKE:
        return tonic
    if mode in MINOR_LIKE:
        return tonic + 12
    raise ValueError(f"{m.get('clip_id')}: unknown scale or mode {mode!r}")


def key_source(m: dict) -> str | None:
    """'exact' when the generator wrote the key (it chose the scale), 'estimated' when it was estimated from the
    melody afterwards (key_info.source), None when the clip has no stored key."""
    if stored_key(m) is None:
        return None
    src = m["key_info"]["source"]
    if src == "generator":
        return "exact"
    if src.startswith("estimated"):
        return "estimated"
    raise ValueError(f"{m.get('clip_id')}: unknown key source {src!r}")
