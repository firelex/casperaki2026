"""Experiment (2026-11-26): split hum-service notes at syllable boundaries (loudness dips inside a note), so sung
"la la la" on one pitch becomes one note per syllable. Scored on the owner's "Alle meine Entchen" la-la recording
(27 known notes) and, as a guard, on HumTrans test (pitch_ok, f_onset vs the unsplit service notes).
Usage: <hum-pitch venv> -I scripts/syllable_split.py"""
import json, sys, uuid, urllib.request
from pathlib import Path
import numpy as np, soundfile as sf
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hum_pitch.core import clip_metrics, frame_rms_db

SVC = "http://127.0.0.1:16510/transcribe"
OWNER = "/home/roli79/casperaki-data/vocal-test-renders/cleanup-test/hum1/raw.wav"
OWNER_FIRST_BEAT = 2.8323
TRUTH = [0, 2, 4, 5, 7, 7, 9, 9, 9, 9, 7, 9, 9, 9, 9, 7, 5, 5, 5, 5, 4, 4, 2, 2, 2, 2, 0]

def service_full(path, fields):
    b = uuid.uuid4().hex
    parts = [f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items()]
    parts.append(f'--{b}\r\nContent-Disposition: form-data; name="audio"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + open(path, "rb").read() + b"\r\n")
    r = urllib.request.Request(SVC, data=b"".join(parts) + f"--{b}--\r\n".encode(), headers={"content-type": f"multipart/form-data; boundary={b}"}, method="POST")
    return json.loads(urllib.request.urlopen(r).read())

def service(path, fields):
    return service_full(path, fields)["notes"]

def split(notes, y, sr, depth_db, edge_s=0.1, gap_s=0.1):
    hop = 0.005
    t = np.arange(0, len(y) / sr, hop)
    db = frame_rms_db(y, sr, t)
    out = []
    for n in notes:
        on, off, m = n["onsetSec"], n["offsetSec"], n["midi"]
        idx = np.flatnonzero((t > on + edge_s) & (t < off - edge_s))
        cuts = []
        for i in idx:
            if not (db[i] <= db[i - 1] and db[i] <= db[i + 1]):
                continue
            w = int(0.08 / hop)
            left, right = db[max(0, i - w):i].max(), db[i + 1:i + 1 + w].max()
            if min(left, right) - db[i] >= depth_db and (not cuts or t[i] - cuts[-1] >= gap_s):
                cuts.append(t[i])
        bounds = [on, *cuts, off]
        out += [[a, b, m] for a, b in zip(bounds, bounds[1:])]
    return out

def split_flux(notes, y, sr, delta, edge_s=0.1, gap_s=0.15):
    """Split inside a note at spectral-flux onsets (backtracked to their start): a new syllable on the same pitch."""
    import librosa
    x = librosa.resample(np.asarray(y, dtype=np.float32), orig_sr=sr, target_sr=22050)
    on = librosa.onset.onset_detect(y=x, sr=22050, hop_length=128, units="time", backtrack=True, delta=delta)
    out = []
    for n in notes:
        a, b, m = n["onsetSec"], n["offsetSec"], n["midi"]
        cuts = []
        for t in on:
            if a + edge_s < t < b - edge_s and (not cuts or t - cuts[-1] >= gap_s):
                cuts.append(float(t))
        bounds = [a, *cuts, b]
        out += [[p, q, m] for p, q in zip(bounds, bounds[1:])]
    return out

MAJOR = (0, 2, 4, 5, 7, 9, 11)
MINOR = (0, 2, 3, 5, 7, 8, 10)

def repitch(pieces, y, sr, key):
    """Every piece's pitch from its own pitch track (pYIN median over its middle), less the recording's tuning
    offset (the median distance of all pieces from a whole semitone), snapped to the service's key."""
    import librosa
    x = librosa.resample(np.asarray(y, dtype=np.float32), orig_sr=sr, target_sr=16000)
    f0, v, _ = librosa.pyin(x, fmin=65, fmax=1000, sr=16000, frame_length=1024, hop_length=160)
    t = librosa.times_like(f0, sr=16000, hop_length=160)
    raw = []
    for a, b, m in pieces:
        lo, hi = a + 0.25 * (b - a), b - 0.25 * (b - a)
        sel = (t >= lo) & (t <= hi) & v & np.isfinite(f0)
        raw.append(float(np.median(librosa.hz_to_midi(f0[sel]))) if sel.sum() >= 3 else None)
    known = [r for r in raw if r is not None]
    if not known:
        return pieces
    off = float(np.median([r - round(r) for r in known]))
    scale = MAJOR if key["scale"] == "major" else MINOR
    allowed = {(key["tonic"] + d) % 12 for d in scale}
    out = []
    for (a, b, m), r in zip(pieces, raw):
        if r is None:
            out.append([a, b, m]); continue
        c = r - off
        cands = [round(c) + d for d in (-1, 0, 1)]
        q = min(cands, key=lambda q: (q % 12 not in allowed, abs(q - c)))
        out.append([a, b, int(q)])
    return out

def merge_on_grid(pieces, first_beat, bpm, per_beat=2):
    """Click mode: pieces starting on the same grid slot (an eighth at per_beat=2) are one note: the first one's start,
    the last one's end, the longest one's pitch."""
    step = 60.0 / bpm / per_beat
    out, group = [], []
    def flush():
        if group:
            longest = max(group, key=lambda p: p[1] - p[0])
            out.append([group[0][0], group[-1][1], longest[2]])
    for p in pieces:
        slot = round((p[0] - first_beat) / step)
        if group and round((group[0][0] - first_beat) / step) == slot:
            group.append(p)
        else:
            flush(); group = [p]
    flush()
    return out

def owner_score(notes):
    mids = [n[2] for n in notes if n[0] >= OWNER_FIRST_BEAT - 0.15]
    best = 99
    for tonic in range(12):
        a = [(x - tonic) % 12 for x in mids]; t = TRUTH
        D = np.zeros((len(a) + 1, len(t) + 1), int); D[:, 0] = range(len(a) + 1); D[0, :] = range(len(t) + 1)
        for i in range(1, len(a) + 1):
            for j in range(1, len(t) + 1):
                D[i, j] = min(D[i - 1, j] + 1, D[i, j - 1] + 1, D[i - 1, j - 1] + (a[i - 1] != t[j - 1]))
        best = min(best, int(D[-1, -1]))
    return len(mids), 27 - best

DEPTHS = [None, 0.1, 'repitch', 'grid']  # None: service; 0.1: split at flux onsets; repitch: split + each piece re-pitched
y, sr = sf.read(OWNER, always_2d=True); y = y.mean(1)
base_full = service_full(OWNER, {"mode": "click", "bpm": "100", "firstBeatSec": str(OWNER_FIRST_BEAT)}); base = base_full["notes"]
for d in DEPTHS:
    est = [[n["onsetSec"], n["offsetSec"], n["midi"]] for n in base] if d is None else split_flux(base, y, sr, 0.1) if d == 0.1 else repitch(split_flux(base, y, sr, 0.1), y, sr, base_full["key"]) if d == 'repitch' else merge_on_grid(repitch(split_flux(base, y, sr, 0.1), y, sr, base_full["key"]), OWNER_FIRST_BEAT, 100)
    n, right = owner_score(est)
    print(f"owner la-la  flux delta {d}: {n} notes after beat 1, {right} of 27 right", flush=True)

recs = [json.loads(l) for l in open("/mnt/d/casperaki-data/hum-pitch/sets/humtrans-test.jsonl")]
shift = json.load(open("/mnt/d/casperaki-data/hum-pitch/sets/humtrans-test.octaves.json"))["shift"]
res = {d: [] for d in DEPTHS}
for k, r in enumerate(recs):
    full = service_full(r["wav"], {"mode": "free"}); notes = full["notes"]
    yy, ss = sf.read(r["wav"], always_2d=True); yy = yy.mean(1)
    ref = [[a, b, m + 12 * shift.get(r["id"], 0)] for a, b, m in r["notes"]]
    for d in DEPTHS:
        est = [[n["onsetSec"], n["offsetSec"], n["midi"]] for n in notes] if d is None else split_flux(notes, yy, ss, 0.1) if d == 0.1 else repitch(split_flux(notes, yy, ss, 0.1), yy, ss, full["key"])  # 'grid' needs a click: as repitch here
        res[d].append(clip_metrics(ref, est))
    if k % 50 == 0: print(f"  humtrans {k}/{len(recs)}", flush=True)
for d in DEPTHS:
    good = sum(m["n_good"] for m in res[d]); nref = sum(m["n_ref"] for m in res[d])
    print(f"HumTrans test flux delta {d}: right pitch {good / nref:.1%} (pooled), f_onset {np.mean([m['f_onset'] for m in res[d]]):.3f}, notes/ref {sum(m['n_est'] for m in res[d]) / nref:.2f}")
