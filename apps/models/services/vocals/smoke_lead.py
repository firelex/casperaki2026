"""GPU smoke for the lead stage on song a31c5ba0: units verse1, chorus1, bridge1 built from its brain song and the
fitted lyrics, sung with 2 seeds each, at the song's octave shift (+12).

Usage (vocals venv): .venv/bin/python smoke_lead.py [out_dir] [seeds=2]
The units are built here as the brain will build them, except:
  * words: the fitted lyric lines split into syllables by a small vowel-group splitter (smoke only; the brain sends
    its own syllables), checked against the number of notes the Vocal lane has for the section;
  * phonemes: placeholders (["?"] per syllable; the brain sends the lane's vocaloidPhonemes).
Prints each step as it finishes and a summary per unit.
"""
import json
import re
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "_serving"))
sys.path.insert(0, str(HERE.parent / "_serving" / "adapters"))

SONG = Path("/home/roli79/casperaki-data/renders/a31c5ba00357d922/brain-song.json")
LYRICS = Path("/mnt/d/casperaki-models/vocal-model-tests/_inputs/lyrics_fitted.txt")
UNITS = ("verse1", "chorus1", "bridge1")
STYLE = "EDM, dance pop, energetic, female lead vocal, synthesizer, drum machine, synth bass, 128 bpm, C major"
OCTAVE = 12  # a31c5ba0's computed shift (global constraints, "Sung register")
OVERRIDES = {"every": ["Ev", "ery"]}
VOWELS = "aeiouy"


def syllables(word):
    """Split a word at vowel groups ("y" counts as a vowel; a final "e"/"es" after a consonant is
    silent when another vowel group exists). Continuing syllables end in "-"."""
    core = re.sub(r"[^A-Za-z']", "", word)
    low = core.lower()
    if low in OVERRIDES:
        parts = OVERRIDES[low]
    else:
        groups = [m.span() for m in re.finditer(r"[aeiouy]+", low)]
        if len(groups) > 1 and re.search(r"[^aeiou](e|es)$", low) and groups[-1][0] >= len(low) - 2:
            groups = groups[:-1]
        if len(groups) <= 1:
            parts = [core]
        else:
            cuts = [0]
            for (_, e1), (s2, _) in zip(groups, groups[1:]):
                cuts.append(e1 + max(0, (s2 - e1) - 1) if s2 - e1 > 1 else e1)
            cuts.append(len(core))
            parts = [core[a:b] for a, b in zip(cuts, cuts[1:])]
    return [p + "-" for p in parts[:-1]] + [parts[-1]]


def build_units(song, blocks):
    sections = song["songStructure"]
    names = [s["name"] for s in sections]
    sung = [s["name"] for s in sections if re.match(r"(verse|chorus|bridge)", s["name"])]
    if len(sung) != len(blocks):
        raise ValueError(f"{len(blocks)} sung lyric blocks for {len(sung)} sung sections")
    by_section = dict(zip(sung, blocks))
    units = []
    for uid in UNITS:
        si = names.index(uid)
        before = [b for s in sections[:si] for b in s["bars"]]
        if len(before) < 2:
            raise ValueError(f"{uid}: fewer than 2 bars before it")
        notes = []
        for bi, bar in enumerate(song["arrangement"][uid]["overrides"]["Vocal"]["bars"]):
            for pos, ns in bar.get("notes", {}).items():
                for n in ns:
                    notes.append({"start": bi * 4 + float(pos), "duration": n["duration"], "midi": n["note"]})
        notes.sort(key=lambda n: n["start"])
        lines = by_section[uid]
        words = [[s for w in line.replace(",", " ").split() for s in syllables(w)] for line in lines]
        if sum(map(len, words)) != len(notes):
            raise ValueError(f"{uid}: {sum(map(len, words))} syllables for {len(notes)} notes: {words}")
        after = [b for s in sections[si + 1:] for b in s["bars"]][:2]
        if len(after) < 2:  # the song's last section: repeat its own last 2 bars' chords
            after = sections[si]["bars"][-2:]
        units.append({"id": uid, "lead_in_chords": [c for b in before[-2:] for c in b["chords"]],
                      "tail_chords": [c for b in after for c in b["chords"]],
                      "chords": [c for b in sections[si]["bars"] for c in b["chords"]], "notes": notes,
                      "lyrics": lines, "words": words, "phonemes": [[["?"] for _ in line] for line in words]})
    return units


class PrintingJob:
    """The harness Job, printing each step when it finishes."""

    def __init__(self):
        import harness

        self.job = harness.Job()
        self.printed = set()
        self.stop = threading.Event()
        threading.Thread(target=self._watch, daemon=True).start()

    def __getattr__(self, name):
        return getattr(self.job, name)

    def _watch(self):
        while not self.stop.wait(1.0):
            self.flush()

    def flush(self):
        for s in self.job.steps():
            if s["state"] != "running" and s["id"] not in self.printed:
                self.printed.add(s["id"])
                print(f"[{s['finished'] - s['started']:6.1f} s] {s['id']:24s} {s['state']:6s} {s['text']} "
                      f"{json.dumps(s['numbers'])}", flush=True)


def main(out_dir=None, seeds="2"):
    import vocals as adapter

    out = Path(out_dir) if out_dir else HERE / "outputs" / f"smoke_lead_{time.strftime('%Y%m%d_%H%M%S')}"
    out.mkdir(parents=True, exist_ok=True)
    adapter.load(type("Ctx", (), {"log": staticmethod(print)})())
    song = json.loads(SONG.read_text())
    blocks = [b.strip().split("\n") for b in LYRICS.read_text().strip().split("\n\n")]
    blocks = [b[1:] for b in blocks if len(b) > 1]
    units = build_units(song, blocks)
    params = {"stage": "lead", "bpm": song["bpm"], "key": song["key"], "style": STYLE, "octave": OCTAVE, "seeds": int(seeds),
              "threshold": 0.7, "units": units}
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
    lead = json.loads(Path(res["file"]).read_text())
    for uid, u in lead["units"].items():
        mel = u["melody"]
        print(f"{uid}: seed {u['seed']}, chords {u['chords_match']:.0%}, {len(mel)} notes: "
              + " ".join(f"{n['word']}@{n['start']:g}:{n['duration']:g}/{n['midi']}" for n in mel))


if __name__ == "__main__":
    main(*sys.argv[1:3])
