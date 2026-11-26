"""Experiment (2026-11-26): a level rider and a slow compressor in front of our vocal chain (pipeline/chain.py).
rider(): loudness over RIDER_WINDOW_S stretches; on singing (within RIDER_GATE_DB of the loudest), a gain towards the
take's median singing level, at most +-RIDER_MAX_DB, eased over RIDER_EASE_S; pauses get no gain.
slow_comp: 2:1, threshold set ~3 dB under the take's median level, attack 30 ms, release 300 ms (LA-2A role).
Usage (vocals venv): python pro_chain.py <in.wav> <out_dir>  -> rider.wav, rider_slowcomp.wav, *_chain.wav"""
import sys
from pathlib import Path
import numpy as np, soundfile as sf
sys.path.insert(0, "/home/roli79/apps/casperaki/apps/models/services/vocals")
from pipeline import chain
from pedalboard import Compressor, Pedalboard

RIDER_WINDOW_S, RIDER_MAX_DB, RIDER_EASE_S, RIDER_GATE_DB = 0.4, 6.0, 0.2, 30.0


def rider(y, sr):
    hop = int(0.01 * sr); win = int(RIDER_WINDOW_S * sr)
    pad = np.pad(y, (win // 2, win // 2))
    c = np.concatenate([[0.0], np.cumsum(pad.astype(np.float64) ** 2)])
    idx = np.arange(0, len(y), hop)
    lvl = 10 * np.log10((c[idx + win] - c[idx]) / win + 1e-12)
    singing = lvl > lvl.max() - RIDER_GATE_DB
    target = np.median(lvl[singing])
    g = np.where(singing, np.clip(target - lvl, -RIDER_MAX_DB, RIDER_MAX_DB), 0.0)
    a = np.exp(-0.01 / RIDER_EASE_S)  # ease forward and back (no lag)
    def ease(x):
        out = np.empty_like(x); acc = 0.0
        for i, v in enumerate(x): acc = a * acc + (1 - a) * v; out[i] = acc
        return out
    g = (ease(g) + ease(g[::-1])[::-1]) / 2
    gain = np.interp(np.arange(len(y)), idx, 10 ** (g / 20))
    return (y * gain).astype(np.float32), target


def slow_comp(y, sr, median_db):
    return Pedalboard([Compressor(threshold_db=float(median_db - 3), ratio=2.0, attack_ms=30, release_ms=300)])(y[None, :], sr)[0]


if __name__ == "__main__":
    src, out = sys.argv[1], Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
    y, sr = sf.read(src, always_2d=True); y = y.mean(1).astype(np.float32)
    r, med = rider(y, sr)
    s = slow_comp(r, sr, med)
    s *= np.sqrt(np.mean(r ** 2)) / np.sqrt(np.mean(s ** 2))  # level matched
    for name, x in (("rider", r), ("rider_slowcomp", s)):
        sf.write(out / f"{name}.wav", x, sr)
        sf.write(out / f"{name}_chain.wav", chain.process(x[:, None], sr), chain.OUT_SR)
        print(name, "done", flush=True)
