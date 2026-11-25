"""GPU smoke for the repeats stage on song a31c5ba0, on the output of the lead smoke (smoke_lead.py).

Usage (vocals venv): .venv/bin/python smoke_repeats.py [lead_dir=outputs/smoke_lead_t7e] [out_dir] [adlib seeds=2]
The out dir must be a sibling of the lead dir (the harness keeps each job's folder side by side; `lead_job` is the lead
dir's name). The params are built here as the brain will build them (Task 9), from the lead smoke's params.json and
lead.json and the song's lanes:
  * copies verse2-4 from verse1: each verse's own lane notes (words, phonemes) on verse1's sung melody by the copy rule
    (`follow` below mirrors the brain's followSung, apps/brain/src/sing/plan.ts);
  * Backing vocals 1 and 2 in chorus1: the song's backing lanes (the brain will send the lanes regenerated after the
    sung lead is applied);
  * ad-libs in chorus4-6 in the gaps of chorus1's sung melody (`gap_bars` mirrors the brain's adlibGapBars).
The song's words are the phrase bank's (the same in every verse), which is enough to exercise every step.
"""
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "_serving"))
sys.path.insert(0, str(HERE.parent / "_serving" / "adapters"))

from smoke_lead import SONG, PrintingJob  # noqa: E402

EPS = 1e-6


def lane(song, name, track):
    out = []
    for bi, bar in enumerate(song["arrangement"][name]["overrides"][track]["bars"]):
        for pos, ns in bar.get("notes", {}).items():
            for n in ns:
                if n.get("type") == "vocalNote":
                    out.append({"start": bi * 4 + float(pos), "duration": n["duration"], "midi": n["note"],
                                "word": n["fullWord"], "phonemes": n["vocaloidPhonemes"]})
    return sorted(out, key=lambda n: n["start"])


def follow(target, source, sung, name):
    """The copy rule (as the brain's followSung)."""
    assert len(source) == len(sung), f"{name}: {len(sung)} sung notes for {len(source)} positions"
    out = []
    for t in target:
        i = max((j for j, q in enumerate(source) if q["start"] <= t["start"] + EPS), default=None)
        if i is None:
            raise ValueError(f"{name}: a note at beat {t['start']} comes before the first note")
        s = sung[i]
        out.append([s["start"] + (t["start"] - source[i]["start"]), s["start"] + s["duration"], s["midi"], t])
    for a, b in zip(out, out[1:]):
        a[1] = min(a[1], b[0])
    return [{"start": st, "duration": max(0.25, round((en - st) * 4) / 4), "midi": m, "word": t["word"],
             "phonemes": t["phonemes"]} for st, en, m, t in out]


def gap_bars(melody, bars):
    """As the brain's adlibGapBars: bars with two beats or more and no syllable starting."""
    out = []
    for b in range(bars):
        a, z = 4 * b, 4 * b + 4
        pts = [a] + sorted(n["start"] for n in melody if a - EPS <= n["start"] < z - EPS) + [z]
        if any(y - x >= 2 - EPS for x, y in zip(pts, pts[1:])):
            out.append(b)
    return out


def main(lead_dir="outputs/smoke_lead_t7e", out_dir=None, seeds="2"):
    import vocals as adapter

    lead_dir = (HERE / lead_dir).resolve() if not Path(lead_dir).is_absolute() else Path(lead_dir)
    out = Path(out_dir).resolve() if out_dir else lead_dir.parent / f"smoke_repeats_{time.strftime('%Y%m%d_%H%M%S')}"
    if out.parent != lead_dir.parent:
        raise SystemExit(f"the out dir {out} must sit beside the lead dir {lead_dir}")
    out.mkdir(parents=True, exist_ok=True)
    adapter.load(type("Ctx", (), {"log": staticmethod(print)})())
    song = json.loads(SONG.read_text())
    lead_params = json.loads((lead_dir / "params.json").read_text())
    lead = json.loads((lead_dir / "lead.json").read_text())["units"]
    units = {u["id"]: u for u in lead_params["units"]}
    bars = {s["name"]: len(s["bars"]) for s in song["songStructure"]}

    copies = [{"segment": v, "from": "verse1", "section_bars": bars[v],
               "notes": follow(lane(song, v, "Vocal"), units["verse1"]["notes"], lead["verse1"]["melody"], v),
               "voice": lead["verse1"]["take"]} for v in ("verse2", "verse3", "verse4")]
    backings = [{"track": t, "segment": "chorus1", "section_bars": bars["chorus1"], "notes": lane(song, "chorus1", t),
                 "voice": lead["chorus1"]["take"]} for t in ("Backing vocals 1", "Backing vocals 2")]
    chorus = units["chorus1"]
    melody = lead["chorus1"]["melody"]
    adlibs = {"chorus_unit": "chorus1", "lead_in_chords": chorus["lead_in_chords"], "chords": chorus["chords"],
              "tail_chords": chorus["tail_chords"], "melody": melody,
              "gaps_bars": gap_bars(melody, len(chorus["chords"]) // 4), "segments": ["chorus4", "chorus5", "chorus6"],
              "seeds": int(seeds), "threshold": 0.7}
    params = {"stage": "repeats", "lead_job": lead_dir.name, "bpm": song["bpm"], "octave": lead_params["octave"],
              "style": lead_params["style"], "copies": copies, "backings": backings, "extensions": [],
              "adlibs": adlibs, "levels": {"reference": lead["chorus1"]["take"], "backing_db": -6, "adlib_db": -4}}
    (out / "params.json").write_text(json.dumps(params, indent=1))
    job = PrintingJob()
    t0 = time.time()
    try:
        res = adapter.generate(None, params, str(out), job)
    finally:
        job.stop.set()
        job.flush()
        (out / "steps.json").write_text(json.dumps(job.job.steps(), indent=1))
    print(f"done in {time.time() - t0:.0f} s -> {res['file']}")
    for t in json.loads(Path(res["file"]).read_text())["takes"]:
        print(f"{t['segment']:8s} {t['track']:18s} {t['kind']:12s} {t['file']:36s} {t['durationSeconds']:.2f} s")


if __name__ == "__main__":
    main(*sys.argv[1:4])
