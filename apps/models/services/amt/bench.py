"""Check and time the cached AMT decode loop (amt_fast) against the spike's.

  services/amt/.venv/bin/python services/amt/bench.py --out <dir> [--dtype fp32|bf16] [--equivalence N]

--equivalence N: for the first N spike melodies (2 prompt bars), sample with the same seed through the spike's
generate and through amt_fast.generate (fp32) and report whether the events are identical, with both timings.
Then writes <out>/completions-<dtype>.jsonl for the spike's 20 melodies x prompt 2 and 4 bars x 3 samples at
top-p 0.95, in the spike's format, so apps/models/amt-spike/score.py scores it like the spike's own run.
"""
import argparse
import json
import sys
import time
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM

SPIKE = Path(__file__).resolve().parents[2] / "amt-spike"
sys.path.insert(0, str(SPIKE))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import amt_complete as spike  # noqa: E402
import amt_fast  # noqa: E402
from music import BEATS_PER_BAR, precedent_chords, precedent_notes  # noqa: E402

WEIGHTS = "/mnt/d/casperaki-models/stanford-crfm__music-medium-800k"


def setup(m):
    tempo = m["tempo"]
    notes = precedent_notes(m["precedent"], m["shift"])
    controls = spike.chord_controls(precedent_chords(m["precedent"], m["shift"], 8), tempo)
    return tempo, notes, controls, spike.ticks(8 * BEATS_PER_BAR, tempo)


def timed(fn, *a):
    torch.cuda.synchronize()
    t0 = time.perf_counter()
    r = fn(*a)
    torch.cuda.synchronize()
    return r, time.perf_counter() - t0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--dtype", choices=["fp32", "bf16"], default="fp32")
    ap.add_argument("--equivalence", type=int, default=0)
    ap.add_argument("--batch", type=int, default=0, help="decode the samples of a melody together, in batches of this size")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(2)
    model = AutoModelForCausalLM.from_pretrained(WEIGHTS, attn_implementation="eager").cuda().eval()
    if args.dtype == "bf16":
        model = model.to(torch.bfloat16)
    melodies = json.loads((SPIKE / "test_melodies.json").read_text())

    for mi, m in enumerate(melodies[: args.equivalence]):
        tempo, notes, controls, end = setup(m)
        start = spike.ticks(2 * BEATS_PER_BAR, tempo)
        prompt = spike.melody_events(notes, tempo, 2 * BEATS_PER_BAR)
        torch.manual_seed(1000 + mi)
        (ev_a, _, _), ta = timed(spike.generate, model, start, end, prompt, list(controls), 0.95)
        torch.manual_seed(1000 + mi)
        (ev_b, _, _), tb = timed(amt_fast.generate, model, start, end, prompt, list(controls), 0.95)
        print(f"equivalence {m['name'][:28]:28s}: identical={ev_a == ev_b} ({len(ev_a)} vs {len(ev_b)} tokens); "
              f"spike {ta:.2f}s, cached {tb:.2f}s", flush=True)

    path = args.out / f"completions-{args.dtype}{'-batch' + str(args.batch) if args.batch else ''}.jsonl"
    secs = []
    with path.open("w") as fh:
        for mi, m in enumerate(melodies):
            tempo, notes, controls, end = setup(m)
            for pb in (2, 4):
                start = spike.ticks(pb * BEATS_PER_BAR, tempo)
                prompt = spike.melody_events(notes, tempo, pb * BEATS_PER_BAR)
                if args.batch:
                    torch.manual_seed(10000 * mi + 1000 * pb)
                    rows = [(start, end, prompt, list(controls), 0.95)] * args.batch
                    batch, sec = timed(amt_fast.generate_batch, model, rows)
                    secs.append(sec)
                    for s, events in enumerate(batch[:3]):
                        fh.write(json.dumps({"id": m["id"], "prompt_bars": pb, "top_p": 0.95, "sample": s, "gen_seconds": sec,
                                             "gpu": torch.cuda.get_device_name(0), "context_tokens": len(events),
                                             "notes": spike.decode_melody(events, tempo, start)}) + "\n")
                    continue
                for s in range(3):
                    torch.manual_seed(10000 * mi + 1000 * pb + s)
                    (events, n_tok, win), sec = timed(amt_fast.generate, model, start, end, prompt, list(controls), 0.95)
                    secs.append(sec)
                    fh.write(json.dumps({"id": m["id"], "prompt_bars": pb, "top_p": 0.95, "sample": s, "gen_seconds": sec,
                                         "gpu": torch.cuda.get_device_name(0), "context_tokens": n_tok,
                                         "notes": spike.decode_melody(events, tempo, start)}) + "\n")
    secs.sort()
    print(f"{args.dtype} batch {args.batch}: {len(secs)} calls, mean {sum(secs)/len(secs):.2f}s, median {secs[len(secs)//2]:.2f}s, "
          f"max {secs[-1]:.2f}s -> {path}")


if __name__ == "__main__":
    main()
