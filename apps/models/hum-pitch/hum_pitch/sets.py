"""Reference notes ready for scoring: synthetic clips as built, HumTrans recordings in the octave the person hummed."""
import json

from .core import SETS_DIR, read_manifest


def references(name: str) -> tuple[list[dict], dict]:
    """(rows, excluded): rows with "notes" ready to score; for HumTrans sets the per-recording octave shift from
    scripts/fit_octaves.py is applied and recordings without a clear octave are left out (excluded: id -> reason)."""
    rows = read_manifest(name)
    if not name.startswith("humtrans"):
        return rows, {}
    path = SETS_DIR / f"{name}.octaves.json"
    if not path.exists():
        raise FileNotFoundError(f"{path} missing: run scripts/fit_octaves.py --sets {name}")
    oc = json.loads(path.read_text())
    out = []
    for r in rows:
        if r["id"] in oc["excluded"]:
            continue
        if r["id"] not in oc["shift"]:
            raise KeyError(f"{r['id']} has no octave shift in {path}: rerun scripts/fit_octaves.py")
        k = oc["shift"][r["id"]]
        out.append(r | {"octave_shift": k, "notes": [[a, b, p + k] for a, b, p in r["notes"]]})
    return out, oc["excluded"]
