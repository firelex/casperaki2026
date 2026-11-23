"""Write MIDI and piano WAV files for listening: the original next to AMT completions.

  python render.py <completions.jsonl> --out <dir> --soundfont <sf2> --pick 1 7 12 ...

For each picked melody (1-based position in test_melodies.json) it writes:
  NN_<name>_original.{mid,wav}
  NN_<name>_amt_<P>bars_p<top_p>_s<sample>.{mid,wav}   for every completion of that melody
Each file holds the melody (prompt bars as given, then the model's bars) on piano, plus
the block chords on a second, quieter piano track. Needs the `fluidsynth` command.
"""

import argparse
import json
import re
import subprocess
from collections import defaultdict
from pathlib import Path

import mido

from music import BEATS_PER_BAR, block_chord_pitches, chord_spans, precedent_chords, precedent_notes

TPB = 480
TOTAL_BARS = 8


def write_midi(path, tempo, melody, per_beat):
    mid = mido.MidiFile(ticks_per_beat=TPB)
    events = defaultdict(list)  # channel -> [(tick, msg)]
    for n in melody:
        on = int(round(n["beat"] * TPB))
        off = on + max(int(round(n["dur"] * TPB)), 1)
        events[0] += [(on, mido.Message("note_on", channel=0, note=n["midi"], velocity=100)),
                      (off, mido.Message("note_off", channel=0, note=n["midi"], velocity=0))]
    for start, end, root, tones in chord_spans(per_beat):
        for p in block_chord_pitches(root, tones):
            events[1] += [(start * TPB, mido.Message("note_on", channel=1, note=p, velocity=55)),
                          (end * TPB - 1, mido.Message("note_off", channel=1, note=p, velocity=0))]
    for ch, evs in sorted(events.items()):
        track = mido.MidiTrack()
        if ch == 0:
            track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(tempo), time=0))
        track.append(mido.Message("program_change", channel=ch, program=0, time=0))
        now = 0
        for tick, msg in sorted(evs, key=lambda e: (e[0], e[1].type == "note_on")):
            track.append(msg.copy(time=tick - now))
            now = tick
        mid.tracks.append(track)
    mid.save(path)


def render_wav(mid_path, wav_path, soundfont):
    subprocess.run(["fluidsynth", "-ni", "-g", "0.8", "-r", "44100", "-F", str(wav_path), soundfont, str(mid_path)],
                   check=True, capture_output=True)


def slug(s):
    return re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-")[:32]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("completions")
    ap.add_argument("--melodies", default=str(Path(__file__).resolve().parent / "test_melodies.json"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--soundfont", required=True)
    ap.add_argument("--pick", type=int, nargs="+", required=True, help="1-based melody numbers")
    ap.add_argument("--top-p", type=float, default=None, help="only completions with this top-p")
    args = ap.parse_args()

    if not Path(args.soundfont).is_file():
        raise SystemExit(f"soundfont not found: {args.soundfont}")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    melodies = json.loads(Path(args.melodies).read_text())
    by_id = defaultdict(list)
    for line in Path(args.completions).read_text().splitlines():
        r = json.loads(line)
        if args.top_p is None or r["top_p"] == args.top_p:
            by_id[r["id"]].append(r)

    written = 0
    for i in args.pick:
        if not 1 <= i <= len(melodies):
            raise SystemExit(f"--pick {i} is outside 1..{len(melodies)}")
        m = melodies[i - 1]
        if m["id"] not in by_id:
            raise SystemExit(f"no completions for {m['id']}")
        notes = precedent_notes(m["precedent"], m["shift"])
        per_beat = precedent_chords(m["precedent"], m["shift"], TOTAL_BARS)
        stem = f"{i:02d}_{slug(m['name'])}_{m['key']}"
        files = [(f"{stem}_original", notes)]
        for r in by_id[m["id"]]:
            prompt = [n for n in notes if n["beat"] < r["prompt_bars"] * BEATS_PER_BAR]
            files.append((f"{stem}_amt_{r['prompt_bars']}bars_p{r['top_p']}_s{r['sample']}", prompt + r["notes"]))
        for name, melody in files:
            mid_path = out / f"{name}.mid"
            write_midi(mid_path, m["tempo"], melody, per_beat)
            render_wav(mid_path, out / f"{name}.wav", args.soundfont)
            written += 1
    print(f"wrote {written} MIDI+WAV pairs to {out}")


if __name__ == "__main__":
    main()
