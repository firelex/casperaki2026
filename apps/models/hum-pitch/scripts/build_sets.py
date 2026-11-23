"""Write the set manifests (one JSON line per clip with its reference notes) to /mnt/d/casperaki-data/hum-pitch/sets/.

  python -I scripts/build_sets.py

Sets:
  humtrans-test  real hums, HumTrans official TEST split, as aligned in hum-beats/test-humtrans (296 recordings).
  humtrans-tune  real hums from the HumTrans TRAIN split (hum-beats/dev-humtrans, 149 recordings): only for
                 choosing Basic Pitch's thresholds. HumTrans is CC BY-NC: evaluation only, never training.
  synth-test     500 synthetic clips: 250 from round one (hum-beats/full/test) and 250 from round two
                 (hum-beats/r2b/test), each 100 voice + 50 breathy + 100 instrument leads, drawn with seed 0.

HumTrans reference notes are the score MIDI shifted by the per-recording time offset that hum-beats fitted (the
singers hummed along with about 0.2 s recording latency; build_humtrans_test.py stores the shifted note times in
each recording's JSON). Notes the offset moves before the start of the recording are left out (printed). They are still in the score's octave: scripts/fit_octaves.py later finds the octave each
person actually hummed in.

Synthetic reference notes are the INTENDED pitch at the PERFORMED onset and offset. Notes the performer swallowed
entirely (no performed onset) are left out; notes swallowed softly stay in.
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hum_pitch.core import SETS_DIR  # noqa: E402

HB = Path("/mnt/d/casperaki-data/hum-beats")
PER_GROUP = {"voice": 100, "breathy": 50, "instrument": 100}


def lead_group(lead: dict) -> str:
    if lead["kind"] in ("voice", "soulx") or lead["group"] == "vocal_sample":
        return "voice"
    if lead["kind"] == "breathy":
        return "breathy"
    if lead["kind"] == "sampler":
        return "instrument"
    raise ValueError(f"unknown lead kind {lead}")


def humtrans(folder: Path, set_name: str) -> list[dict]:
    rows = []
    for js in sorted(folder.glob("*.json")):
        if js.name == "summary.json":
            continue
        m = json.loads(js.read_text())
        wav = js.with_suffix(".wav")
        if not wav.exists():
            raise FileNotFoundError(wav)
        notes = [[n["onset"], n["offset"], int(n["midi"])] for n in m["notes"]]
        cut = [x for x in notes if x[0] < 0]
        if cut:  # the fitted offset puts these notes before the recording starts: no onset to find in the audio
            print(f"{m['clip_id']}: {len(cut)} reference note(s) start before the recording (offset {m['offset_s']:+.3f} s), left out")
            notes = [x for x in notes if x[0] >= 0]
        rows.append({"id": m["clip_id"], "set": set_name, "wav": str(wav), "group": "real hum", "lead": "hum",
                     "singer": m["singer"], "sex": m["singer"][0], "offset_s": m["offset_s"], "notes": notes})
    if not rows:
        raise FileNotFoundError(f"no recordings in {folder}")
    return rows


def synth(folder: Path, round_name: str, rng: np.random.Generator) -> list[dict]:
    by_group: dict[str, list[dict]] = {g: [] for g in PER_GROUP}
    for js in sorted(folder.glob("*.json")):
        m = json.loads(js.read_text())
        by_group[lead_group(m["lead"])].append(m | {"_json": js})
    rows = []
    for g, want in PER_GROUP.items():
        have = by_group[g]
        if len(have) < want:
            raise ValueError(f"{folder}: only {len(have)} {g} clips, need {want}")
        for i in sorted(rng.choice(len(have), size=want, replace=False)):
            m = have[i]
            notes = []
            for n in m["notes"]:
                if n["performed_onset"] is None:
                    continue
                if n["performed_offset"] is None:
                    raise ValueError(f"{m['clip_id']}: note with a performed onset but no performed offset: {n}")
                notes.append([n["performed_onset"], n["performed_offset"], int(n["midi"])])
            wav = m["_json"].with_suffix(".wav")
            if not wav.exists():
                raise FileNotFoundError(wav)
            rows.append({"id": f"{round_name}/{m['clip_id']}", "set": "synth-test", "wav": str(wav), "group": g,
                         "round": round_name, "lead": m["lead"]["kind"], "timbre": m["lead"]["timbre"],
                         "pollution": m["pollution"]["level"], "timing": m["timing"], "bpm": m["bpm"], "notes": notes})
    return rows


def write(name: str, rows: list[dict]) -> None:
    SETS_DIR.mkdir(parents=True, exist_ok=True)
    with open(SETS_DIR / f"{name}.jsonl", "w") as f:
        f.writelines(json.dumps(r) + "\n" for r in rows)
    print(name, len(rows), "clips", sum(len(r["notes"]) for r in rows), "notes")


def main():
    write("humtrans-test", humtrans(HB / "test-humtrans", "humtrans-test"))
    write("humtrans-tune", humtrans(HB / "dev-humtrans", "humtrans-tune"))
    rng = np.random.default_rng(0)
    write("synth-test", synth(HB / "full/test", "r1", rng) + synth(HB / "r2b/test", "r2b", rng))


if __name__ == "__main__":
    main()
