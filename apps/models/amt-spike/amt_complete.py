"""Complete hummed melodies with the Anticipatory Music Transformer (AMT).

For each test melody: the first N bars of the melody are the prompt (ordinary events),
block chords for all 8 bars are an accompaniment instrument given as anticipated
controls, and the model samples the melody for bars N+1..8. Sampling is restricted so
the model may only write notes for the melody instrument (or the model's REST padding
token); everything else in the decode loop is the library's own `generate` logic.

Writes one JSON line per completion to <out>/completions.jsonl.

Run on a GPU host with the AMT venv:
  python amt_complete.py --out <dir> [--model stanford-crfm/music-medium-800k]
"""

import argparse
import json
import math
import time
from pathlib import Path

import torch
import torch.nn.functional as F
from transformers import AutoModelForCausalLM

from anticipation import ops
from anticipation.config import DELTA, MAX_DUR, MAX_PITCH, TIME_RESOLUTION
from anticipation.sample import future_logits, instr_logits, nucleus, safe_logits
from anticipation.vocab import (ANTICIPATE, ATIME_OFFSET, CONTROL_OFFSET, DUR_OFFSET,
                                NOTE_OFFSET, REST, TIME_OFFSET)

from music import (BEATS_PER_BAR, block_chord_pitches, chord_spans, precedent_chords,
                   precedent_notes)

MELODY_PROGRAM = 53   # General MIDI "Voice Oohs": the melody line
CHORD_PROGRAM = 0     # General MIDI "Acoustic Grand Piano": block-chord accompaniment
TOTAL_BARS = 8


def ticks(beat, tempo):
    return int(round(beat * 60.0 / tempo * TIME_RESOLUTION))


def note_token(program, pitch):
    return NOTE_OFFSET + program * MAX_PITCH + pitch


def melody_events(notes, tempo, end_beat):
    events = []
    for n in notes:
        if n["beat"] >= end_beat:
            continue
        d = min(max(ticks(n["dur"], tempo), 1), MAX_DUR - 1)
        events.extend([TIME_OFFSET + ticks(n["beat"], tempo), DUR_OFFSET + d, note_token(MELODY_PROGRAM, n["midi"])])
    return ops.sort(events)


def chord_controls(per_beat, tempo):
    """Block chords, re-struck at every chord change and every bar line, as control tokens."""
    events = []
    for start, end, root, tones in chord_spans(per_beat):
        cuts = sorted({start, end} | {b for b in range(start + 1, end) if b % BEATS_PER_BAR == 0})
        for a, b in zip(cuts[:-1], cuts[1:]):
            t0, t1 = ticks(a, tempo), ticks(b, tempo)
            d = min(t1 - t0, MAX_DUR - 1)
            for pitch in block_chord_pitches(root, tones):
                events.extend([TIME_OFFSET + t0, DUR_OFFSET + d, note_token(CHORD_PROGRAM, pitch)])
    events = ops.sort(events)
    return [CONTROL_OFFSET + tok for tok in events]


def melody_only_logits(logits):
    keep = torch.full_like(logits, -float("inf"))
    lo = note_token(MELODY_PROGRAM, 0)
    keep[lo:lo + MAX_PITCH] = 0.0
    keep[REST] = 0.0
    return logits + keep


def add_token(model, z, tokens, top_p, current_time):
    """sample.add_token from the library, plus the melody-only restriction on the note token."""
    assert len(tokens) % 3 == 0
    history = tokens.copy()
    lookback = max(len(tokens) - 1017, 0)
    history = history[lookback:]
    offset = ops.min_time(history, seconds=False)
    history[::3] = [tok - offset for tok in history[::3]]

    new_token = []
    with torch.no_grad():
        for i in range(3):
            input_tokens = torch.tensor(z + history + new_token).unsqueeze(0).to(model.device)
            logits = model(input_tokens).logits[0, -1]
            idx = input_tokens.shape[1] - 1
            logits = safe_logits(logits, idx)
            if i == 0:
                logits = future_logits(logits, current_time - offset)
            elif i == 2:
                logits = instr_logits(logits, tokens)
                logits = melody_only_logits(logits)
            logits = nucleus(logits, top_p)
            probs = F.softmax(logits, dim=-1)
            new_token.append(int(torch.multinomial(probs, 1)))
    new_token[0] += offset
    return new_token, lookback > 0


def generate(model, start_ticks, end_ticks, prompt_events, controls, top_p):
    """The library's sample.generate (anticipation mode), minus its clipping of controls
    in the first 50 ms (which would drop the chord on beat 1), with melody-only decoding."""
    delta = DELTA * TIME_RESOLUTION
    prompt = ops.pad(prompt_events, start_ticks)
    z = [ANTICIPATE]
    tokens, controls = ops.anticipate(prompt, controls)
    current_time = ops.max_time(prompt, seconds=False)
    hit_window = False

    if controls:
        atime, adur, anote = controls[0:3]
        pending = controls[3:]
        anticipated_time = atime - ATIME_OFFSET
    else:
        anticipated_time = math.inf

    while True:
        while current_time >= anticipated_time - delta:
            tokens.extend([atime, adur, anote])
            if pending:
                atime, adur, anote = pending[0:3]
                pending = pending[3:]
                anticipated_time = atime - ATIME_OFFSET
            else:
                anticipated_time = math.inf
        new_token, windowed = add_token(model, z, tokens, top_p, max(start_ticks, current_time))
        hit_window = hit_window or windowed
        new_time = new_token[0] - TIME_OFFSET
        if new_time >= end_ticks:
            break
        tokens.extend(new_token)
        if new_time < current_time:
            raise RuntimeError(f"sampled time went backwards: {new_time} < {current_time}")
        current_time = new_time

    events, _ = ops.split(tokens)
    return ops.unpad(events), len(tokens), hit_window


def decode_melody(events, tempo, from_ticks):
    notes = []
    for t, d, n in zip(events[0::3], events[1::3], events[2::3]):
        if n == REST:
            continue
        program, pitch = divmod(n - NOTE_OFFSET, MAX_PITCH)
        if program != MELODY_PROGRAM:
            raise RuntimeError(f"decoded a note for program {program}; decoding should allow only the melody")
        tt = t - TIME_OFFSET
        if tt < from_ticks:
            continue
        sec_per_beat = 60.0 / tempo
        notes.append({
            "beat": tt / TIME_RESOLUTION / sec_per_beat,
            "dur": (d - DUR_OFFSET) / TIME_RESOLUTION / sec_per_beat,
            "midi": pitch,
        })
    return notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="stanford-crfm/music-medium-800k")
    ap.add_argument("--melodies", default=str(Path(__file__).resolve().parent / "test_melodies.json"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--prompt-bars", type=int, nargs="+", default=[2, 4])
    ap.add_argument("--top-p", type=float, nargs="+", default=[0.95, 0.98])
    ap.add_argument("--samples", type=int, default=3)
    ap.add_argument("--limit", type=int, default=None, help="only the first N melodies")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    melodies = json.loads(Path(args.melodies).read_text())
    if args.limit:
        melodies = melodies[: args.limit]

    if not torch.cuda.is_available():
        raise SystemExit("no CUDA device visible")
    # eager attention is required: the SDPA path in transformers ignores the model's
    # scale_attn_by_inverse_layer_idx=True and gives a broken model (NLL worse than uniform)
    model = AutoModelForCausalLM.from_pretrained(args.model, attn_implementation="eager").cuda().eval()
    device_name = torch.cuda.get_device_name(0)

    out_path = out_dir / "completions.jsonl"
    with out_path.open("w") as fh:
        for mi, m in enumerate(melodies):
            tempo = m["tempo"]
            notes = precedent_notes(m["precedent"], m["shift"])
            per_beat = precedent_chords(m["precedent"], m["shift"], TOTAL_BARS)
            controls = chord_controls(per_beat, tempo)
            end_ticks = ticks(TOTAL_BARS * BEATS_PER_BAR, tempo)
            for pb in args.prompt_bars:
                start_beat = pb * BEATS_PER_BAR
                start_ticks = ticks(start_beat, tempo)
                prompt = melody_events(notes, tempo, start_beat)
                for top_p in args.top_p:
                    for s in range(args.samples):
                        seed = 10000 * mi + 1000 * pb + 10 * int(round(top_p * 100)) + s
                        torch.manual_seed(seed)
                        torch.cuda.synchronize()
                        t0 = time.perf_counter()
                        events, n_tokens, windowed = generate(model, start_ticks, end_ticks, prompt, list(controls), top_p)
                        torch.cuda.synchronize()
                        elapsed = time.perf_counter() - t0
                        gen = decode_melody(events, tempo, start_ticks)
                        rec = {
                            "id": m["id"], "name": m["name"], "bank": m["bank"], "key": m["key"],
                            "tempo": tempo, "prompt_bars": pb, "top_p": top_p, "sample": s,
                            "seed": seed, "model": args.model, "gpu": device_name,
                            "gen_seconds": elapsed, "context_tokens": n_tokens,
                            "context_window_exceeded": windowed, "notes": gen,
                        }
                        fh.write(json.dumps(rec) + "\n")
                        fh.flush()
                        print(f"[{mi+1}/{len(melodies)}] {m['name'][:30]:30s} bars={pb} p={top_p} s={s} "
                              f"notes={len(gen)} tokens={n_tokens} {elapsed:.2f}s", flush=True)
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
