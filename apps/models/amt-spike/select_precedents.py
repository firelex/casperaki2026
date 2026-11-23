"""Pick 20 eight-bar vocal precedents (varied keys and styles) as AMT test melodies.

Reads the brain's precedent banks (packages/arrangement/data/vocals/precedents) and writes
test_melodies.json: each entry has the source fields plus the transposition used.
The banks store everything in C; each melody is moved back to its song's original key
(the stefan bank has no original key, so those get fixed keys from STEFAN_KEYS).
"""

import json
import sys
from pathlib import Path

from music import BEATS_PER_BAR, bar_of, precedent_chords, precedent_notes, signed_shift_to

BANK_DIR = Path(__file__).resolve().parents[3] / "packages" / "arrangement" / "data" / "vocals" / "precedents"
PLAN = [("drLuke", 6), ("limitedRange", 5), ("schlager", 6), ("stefan", 3)]
STEFAN_KEYS = ["E", "Bb", "G"]


def usable(p):
    props = p["properties"]
    if (props["start"], props["end"]) != (0, 8):
        return False
    if len(p["chords"]) != 8 * BEATS_PER_BAR:
        return False
    notes = precedent_notes(p, 0)
    if len({n["midi"] for n in notes}) < 4:
        return False
    first2 = [n for n in notes if bar_of(n["beat"]) < 2]
    later = [n for n in notes if bar_of(n["beat"]) >= 4]
    return len(first2) >= 3 and len(later) >= 6


def main():
    out = []
    used_keys = {}
    for bank, count in PLAN:
        entries = json.loads((BANK_DIR / f"mlDataRaw-{bank}.json").read_text())
        seen_names = set()
        picked = []
        # walk the bank, preferring keys we have used least so far
        candidates = [p for p in entries if usable(p)]
        while len(picked) < count:
            best = None
            for p in candidates:
                name = p["properties"]["name"]
                if name in seen_names:
                    continue
                key = STEFAN_KEYS[len(picked)] if bank == "stefan" else p["properties"]["originalKey"]
                score = used_keys.get(key, 0)
                if best is None or score < best[0]:
                    best = (score, p, key)
            if best is None:
                raise SystemExit(f"bank {bank}: only {len(picked)} usable distinct songs, wanted {count}")
            _, p, key = best
            seen_names.add(p["properties"]["name"])
            used_keys[key] = used_keys.get(key, 0) + 1
            shift = signed_shift_to(key)
            precedent_chords(p, shift, 8)  # fail now if any chord is unparseable
            picked.append({
                "id": f"{bank}:{p['id'] if 'id' in p else p['properties']['name']}",
                "bank": bank,
                "name": p["properties"]["name"],
                "section": p["properties"]["type"],
                "key": key,
                "shift": shift,
                "tempo": float(p["properties"]["tempo"]),
                "precedent": p,
            })
        out.extend(picked)
    dest = Path(__file__).resolve().parent / "test_melodies.json"
    dest.write_text(json.dumps(out, indent=1))
    for m in out:
        print(f"{m['bank']:13s} {m['key']:3s} {m['tempo']:5.0f} {m['section']:11s} {m['name']}")
    print(f"wrote {len(out)} melodies to {dest}", file=sys.stderr)


if __name__ == "__main__":
    main()
