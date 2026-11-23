"""Add the key (tonic and scale, the format the notes trainer reads) to the round-two-b clip JSONs without
regenerating audio: the melody stage is rerun from each clip's plan row (deterministic), checked against the stored
notes (pitch and score position must match exactly, otherwise it stops), and "key" + "key_info" are written in.

  python scripts/backfill_keys.py --data /mnt/d/casperaki-data/hum-beats/r2b --workers 16
"""
import argparse
import json
import sys
from multiprocessing import Pool
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hum_beats import generate2 as g2  # noqa: E402

_CTX = None
_DATA = None


def _init(data):
    global _CTX, _DATA
    _CTX = g2.Context(Path.home() / ".cache/casperaki/hum-beats-sounds", Path(__file__).resolve().parents[2] / "services/soulx-singer/repo")
    _DATA = Path(data)


def _one(row):
    f = _DATA / row["split"] / f"{row['clip_id']}.json"
    if not f.exists():
        return "missing"  # a SoulX clip rejected at generation time: there is no clip to label
    m = json.loads(f.read_text())
    st = g2.make_state(row, _CTX)
    a = [(n["midi"], n["q_on"]) for n in m["notes"]]
    b = [(n.midi, round(n.q_on, 5)) for n in st["score"].notes]
    if a != b:
        raise ValueError(f"{row['clip_id']}: regenerated melody differs from the stored one")
    m["key"] = {"tonic": st["key"]["tonic"], "scale": st["key"]["scale"]}
    m["key_info"] = st["key"]["info"]
    tmp = f.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(m))
    tmp.replace(f)
    return st["key"]["info"]["source"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--workers", type=int, default=16)
    args = ap.parse_args()
    rows = [json.loads(line) for line in open(args.data / "plan.jsonl")]
    from collections import Counter
    with Pool(args.workers, initializer=_init, initargs=(str(args.data),)) as pool:
        c = Counter(pool.imap_unordered(_one, rows, chunksize=32))
    print(dict(c))


if __name__ == "__main__":
    main()
