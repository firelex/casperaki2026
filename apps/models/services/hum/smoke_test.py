"""Smoke test for the hum service (POST /transcribe), against labelled clips.

  services/hum/.venv/bin/python services/hum/smoke_test.py [--url http://127.0.0.1:16510]

1. A real hum (HumTrans test, a woman's recording, so the score octave is the sung one) in free mode.
2. A synthetic hum (round three test, 4/4, steady "perfect" timing) in click mode, with its labelled tempo and
   first downbeat.
Prints beat F-measure (70 ms), note accuracy (right MIDI pitch, onset within 100 ms) and latency. Exits non-zero
when a request fails or a score is clearly broken (beat F < 0.5 in click mode, no note right).
"""
import argparse
import glob
import json
import sys
import time
import urllib.request
import uuid

import mir_eval
import numpy as np

DATA = "/mnt/d/casperaki-data/hum-beats"


def post(url, wav, fields):
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="a.wav"\r\n'
                 f"Content-Type: audio/wav\r\n\r\n".encode() + open(wav, "rb").read() + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(url + "/transcribe", data=b"".join(parts),
                                 headers={"content-type": f"multipart/form-data; boundary={boundary}"})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            out = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code}: {e.read().decode()}") from None
    return out, time.perf_counter() - t0


def note_score(ref, est):
    if not est:
        return 0.0
    ri = np.array([[n[0], n[0] + 0.1] for n in ref])
    rp = mir_eval.util.midi_to_hz(np.array([n[1] for n in ref], dtype=float))
    ei = np.array([[n["onsetSec"], n["offsetSec"]] for n in est])
    ep = mir_eval.util.midi_to_hz(np.array([n["midi"] for n in est], dtype=float))
    p, r, f, _ = mir_eval.transcription.precision_recall_f1_overlap(ri, rp, ei, ep, onset_tolerance=0.1, pitch_tolerance=50,
                                                                     offset_ratio=None)
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:16510")
    args = ap.parse_args()
    ok = True

    # 1. real hum, free mode
    wav = f"{DATA}/test-humtrans/F01_0024_0001_2.wav"
    m = json.load(open(wav[:-4] + ".json"))
    lab = np.loadtxt(wav[:-4] + ".beats", ndmin=2)
    out, sec = post(args.url, wav, {"mode": "free"})
    bf = mir_eval.beat.f_measure(mir_eval.beat.trim_beats(lab[:, 0]), mir_eval.beat.trim_beats(np.array(out["beats"])))
    ref = [(n["onset"], n["midi"]) for n in m["notes"]]
    nr = note_score(ref, out["notes"])
    print(f"free  {m['clip_id']}: {sec*1000:.0f} ms (service {out['tookMs']} ms); bpm {out['bpm']:.1f} (label {m['bpm']:.1f}); "
          f"beat F {bf:.2f}; notes {len(out['notes'])} (ref {len(ref)}), right {nr:.0%}; key {out['key']}")
    ok &= nr > 0

    # 2. synthetic hum, click mode
    for f in sorted(glob.glob(f"{DATA}/r3/test/*.json")):
        s = json.load(open(f))
        if s["meter"] == "4/4" and s["timing"] == "perfect":
            break
    else:
        raise SystemExit("no 4/4 perfect-timing clip in r3/test")
    lab = np.loadtxt(f[:-5] + ".beats", ndmin=2)
    first = float(lab[lab[:, 1] == 1][0, 0])
    out, sec = post(args.url, f[:-5] + ".wav", {"mode": "click", "bpm": s["bpm"], "firstBeatSec": first})
    bf = mir_eval.beat.f_measure(mir_eval.beat.trim_beats(lab[:, 0]), mir_eval.beat.trim_beats(np.array(out["beats"])))
    ref = [(n["performed_onset"], n["midi"]) for n in s["notes"] if n["performed_onset"] is not None]
    nr = note_score(ref, out["notes"])
    print(f"click {s['clip_id']}: {sec*1000:.0f} ms (service {out['tookMs']} ms); bpm {out['bpm']:.1f}; beat F {bf:.2f}; "
          f"notes {len(out['notes'])} (ref {len(ref)}), right {nr:.0%}; key {out['key']} (label {s['key']})")
    ok &= bf >= 0.5 and nr > 0
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
