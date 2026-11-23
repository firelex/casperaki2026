"""Turn a performed melody into audio: the pitch curve, three kinds of sound source, and the pollution chain.

Sound sources:
  * voice   - a humming / singing voice synthesiser: harmonic (glottal-like) source with spectral tilt,
              vowel formant filters ("mm", "oo", "ah", "la", "da"; "ee" exists only for test-unseen),
              breathiness, consonant onsets for la/da, breath noise between phrases.
  * breathy - flute, whistle and ocarina (ocarina only for test-unseen) by additive synthesis plus noise.
  * sampler - a library recording: nearest measured slot, pitch-shifted by resampling.

Every source is driven by the same performed pitch curve (cents = 100 x MIDI, 1 kHz control rate), which is
also what we store as the label of what was actually sung or played.
"""
from __future__ import annotations

import math

import numpy as np
from scipy.signal import butter, lfilter, sosfilt

from .sounds import SR

CTRL = 1000  # control rate of pitch and loudness curves (Hz)

VOWELS = {  # formant frequencies (Hz), bandwidths (Hz), relative gains (adult male reference)
    "oo": ([300, 870, 2240, 3000], [60, 90, 120, 200], [1.0, 0.35, 0.08, 0.03]),
    "ah": ([730, 1090, 2440, 3300], [80, 90, 120, 200], [1.0, 0.6, 0.25, 0.1]),
    "la": ([650, 1080, 2450, 3300], [80, 90, 120, 200], [1.0, 0.55, 0.25, 0.1]),
    "da": ([700, 1200, 2500, 3400], [80, 100, 130, 200], [1.0, 0.5, 0.22, 0.1]),
    "mm": ([250, 1100, 2300, 3000], [60, 200, 250, 300], [1.0, 0.05, 0.02, 0.01]),
    "ee": ([270, 2290, 3010, 3600], [60, 100, 140, 200], [1.0, 0.3, 0.2, 0.08]),
}
TRAIN_VOWELS = ["mm", "oo", "ah", "la", "da"]
UNSEEN_VOWELS = ["ee"]

VOICE_TYPES = {  # median MIDI of the comfortable range, formant scale
    "low_male": (50, 1.0),
    "high_male": (57, 1.05),
    "female": (65, 1.16),
    "child": (71, 1.28),
}
BREATHY_MEDIAN = {"flute": 76, "whistle": 83, "ocarina": 74}


# --------------------------------------------------------------------------------------------------------
# Pitch curve
# --------------------------------------------------------------------------------------------------------

def pitch_amounts(rng, strength: float) -> dict:
    """Per-clip pitch imperfection settings for a strength 0..1."""
    return {
        "strength": strength,
        "note_sd_cents": rng.uniform(0, 22) * strength,
        "drift_cents": rng.uniform(-1, 1) * 100 * strength,
        "scoop_p": rng.uniform(0, 0.7) * strength,
        "scoop_cents": rng.uniform(30, 200) * max(strength, 0.2),
        "fall_p": rng.uniform(0, 0.5) * strength,
        "overshoot_cents": rng.uniform(0, 70) * strength,
        "glide_ms": rng.uniform(25, 120),
        "vibrato_depth": rng.uniform(0, 60) * max(strength, 0.3),
        "vibrato_rate": rng.uniform(4.3, 6.8),
        "vibrato_delay": rng.uniform(0.12, 0.45),
        "micro_cents": rng.uniform(1, 8),
    }


def pitch_curve(rng, notes: list[dict], dur: float, pa: dict, expressive: bool) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """Performed pitch (cents) and voiced mask on the CTRL grid, plus per-note pitch facts.

    expressive=False (keys, plucks...): one steady, slightly detuned pitch per note, no scoops or vibrato."""
    n = int(math.ceil(dur * CTRL)) + 1
    t = np.arange(n) / CTRL
    cents = np.full(n, np.nan)
    facts = []
    mids = [x["midi"] for x in notes]
    hi_ref = np.percentile(mids, 75) if mids else 0
    prev_cents_end = None
    prev_off = -1.0
    drift_rate = pa["drift_cents"] / max(dur, 1e-3)
    for i, nt in enumerate(notes):
        if nt["swallowed"] == "missing":
            facts.append({"offset_cents": None})
            prev_cents_end = None
            continue
        a, b = int(nt["onset"] * CTRL), int(nt["offset"] * CTRL)
        b = max(b, a + 2)
        tt = t[a:b] - nt["onset"]
        leap = (nt["midi"] - notes[i - 1]["midi"]) if i > 0 else 0
        sd = pa["note_sd_cents"] * (1.5 if abs(leap) > 4 else 1.0) * (1.3 if nt["midi"] > hi_ref else 1.0)
        off = float(np.clip(rng.normal(0, sd), -60, 60)) if sd > 0 else 0.0
        base = 100.0 * nt["midi"] + off + drift_rate * t[a:b]
        if not expressive:
            curve = 0.3 * (base - 100.0 * nt["midi"]) + 100.0 * nt["midi"]
            cents[a:b] = curve
            facts.append({"offset_cents": round(0.3 * off, 2), "scoop": 0, "fall": 0, "overshoot": 0, "vibrato_depth": 0})
            continue
        curve = base.copy()
        scoop = overshoot = fall = 0.0
        legato_in = prev_cents_end is not None and nt["onset"] - prev_off < 0.03
        tau = pa["glide_ms"] / 1000 / 3
        if legato_in:
            curve += (prev_cents_end - base[0]) * np.exp(-tt / tau)  # glide from the previous note
        elif rng.random() < pa["scoop_p"]:
            scoop = rng.uniform(0.3, 1.0) * pa["scoop_cents"]
            curve -= scoop * np.exp(-tt / (tau * rng.uniform(1, 2)))
        if abs(leap) >= 5 and pa["overshoot_cents"] > 0:
            overshoot = rng.uniform(0.4, 1.0) * pa["overshoot_cents"] * np.sign(leap)
            curve += overshoot * np.exp(-tt / 0.08) * np.sin(np.pi * np.clip(tt / 0.12, 0, 1))
        note_len = (b - a) / CTRL
        vib_depth = pa["vibrato_depth"] * rng.uniform(0.4, 1.3)
        if note_len > 0.35 and vib_depth > 0:
            rate = pa["vibrato_rate"] * (1 + 0.08 * np.sin(2 * np.pi * tt * rng.uniform(0.3, 0.9)))
            ramp = np.clip((tt - pa["vibrato_delay"]) / 0.25, 0, 1)
            curve += vib_depth * ramp * np.sin(2 * np.pi * np.cumsum(rate) / CTRL)
        else:
            vib_depth = 0.0
        next_gap = (notes[i + 1]["onset"] - nt["offset"]) if i + 1 < len(notes) else math.inf
        if next_gap > 0.15 and rng.random() < pa["fall_p"]:
            fall = rng.uniform(50, 300)
            fl = min(note_len * 0.5, rng.uniform(0.08, 0.2))
            curve -= fall * np.clip((tt - (note_len - fl)) / fl, 0, 1) ** 2
        micro = np.convolve(rng.normal(0, 1, len(tt) + 40), np.ones(40) / 40 ** 0.5, mode="same")[20:20 + len(tt)]
        curve += pa["micro_cents"] * micro / 3
        cents[a:b] = curve
        prev_cents_end = float(curve[-1])
        prev_off = nt["offset"]
        facts.append({"offset_cents": round(off, 2), "scoop": round(scoop, 1), "fall": round(fall, 1), "overshoot": round(float(overshoot), 1), "vibrato_depth": round(vib_depth, 1)})
    return cents, ~np.isnan(cents), facts


def loudness_curve(notes: list[dict], dur: float, attack_s: float, release_s: float, legato_dip: float) -> np.ndarray:
    """Amplitude envelope on the CTRL grid (raised-cosine attack and release, legato notes stay connected)."""
    n = int(math.ceil(dur * CTRL)) + 1
    env = np.zeros(n)
    for i, nt in enumerate(notes):
        if nt["velocity"] <= 0:
            continue
        # the rise starts 40% of the attack before the onset, so the perceived onset (half-way up a soft
        # attack) sits at the labelled time
        att = max(2, int(attack_s * CTRL))
        a, b = max(0, int(nt["onset"] * CTRL) - int(0.4 * att)), int(nt["offset"] * CTRL)
        rel = int(release_s * CTRL)
        seg = np.ones(max(b - a, 1) + rel)
        k = min(att, len(seg))
        seg[:k] = 0.5 - 0.5 * np.cos(np.pi * np.arange(k) / k)
        if legato_dip > 0 and i > 0 and nt["articulation"] == "legato":
            seg[:k] = 1 - legato_dip * (1 - seg[:k])
        if rel > 0:
            seg[-rel:] *= 0.5 + 0.5 * np.cos(np.pi * np.arange(rel) / rel)
        seg *= nt["velocity"] ** 1.3
        end = min(n, a + len(seg))
        env[a:end] = np.maximum(env[a:end], seg[: end - a])
    return env


def to_audio_rate(x: np.ndarray, n_samples: int) -> np.ndarray:
    return np.interp(np.arange(n_samples) / SR, np.arange(len(x)) / CTRL, x)


# --------------------------------------------------------------------------------------------------------
# Sources
# --------------------------------------------------------------------------------------------------------

def _resonator(x: np.ndarray, f: float, bw: float) -> np.ndarray:
    r = math.exp(-math.pi * bw / SR)
    th = 2 * math.pi * f / SR
    b0 = (1 - r * r) * 0.5
    return lfilter([b0, 0, -b0], [1, -2 * r * math.cos(th), r * r], x)


def harmonic_source(f0: np.ndarray, voiced: np.ndarray, tilt: float, max_harm: int, nyq_frac: float = 0.45) -> np.ndarray:
    phase = 2 * np.pi * np.cumsum(f0 / SR)
    out = np.zeros_like(f0)
    fmax = float(np.max(f0[voiced])) if np.any(voiced) else 200.0
    k_max = int(min(max_harm, (nyq_frac * SR) / fmax))
    for k in range(1, k_max + 1):
        out += (k ** -tilt) * np.sin(k * phase)
    return out


# voice timbres for round three (male voices): ranges that override the default draws
VOICE_TIMBRES = {
    "plain": {},
    "breathy": {"tilt": (1.6, 2.4), "breath": (0.35, 0.6)},
    "chesty": {"tilt": (0.9, 1.3), "breath": (0.0, 0.1), "formant": (0.9, 0.98)},
    "mumbled": {"tilt": (1.8, 2.6), "breath": (0.1, 0.3), "lowpass": (300.0, 550.0)},
}


def render_voice(rng, cents_s, voiced_s, env_s, vowel: str, formant_scale: float, notes: list[dict], dur: float, unseen: bool,
                 normalize_notes: bool = False, timbre: str | None = None) -> tuple[np.ndarray, dict]:
    n = len(cents_s)
    f0 = 440.0 * 2 ** ((np.nan_to_num(cents_s, nan=6000.0) - 6900.0) / 1200)
    tilt = rng.uniform(1.2, 2.2)
    breath = rng.uniform(0.0, 0.35)
    lowpass = None
    if timbre is not None:  # drawn after the default draws, so clips without a timbre are unchanged
        t = VOICE_TIMBRES[timbre]
        if "tilt" in t:
            tilt = rng.uniform(*t["tilt"])
        if "breath" in t:
            breath = rng.uniform(*t["breath"])
        if "formant" in t:
            formant_scale = formant_scale * rng.uniform(*t["formant"])
        if "lowpass" in t:
            lowpass = rng.uniform(*t["lowpass"])
    src = harmonic_source(f0, voiced_s, tilt, 60)
    src = src / (np.std(src[voiced_s]) + 1e-9) if np.any(voiced_s) else src
    noise = rng.normal(0, 1, n)
    excitation = src * (1 - breath) + noise * breath * 0.6
    amp = env_s.copy()
    # consonant onsets for la / da
    if vowel in ("la", "da"):
        for nt in notes:
            if nt["velocity"] <= 0:
                continue
            a = int(nt["onset"] * SR)
            if vowel == "la":
                k = int(0.05 * SR)
                end = min(n, a + k)
                amp[a:end] *= 1 - 0.55 * np.sin(np.pi * np.arange(end - a) / k)
            else:
                closure, burst = int(rng.uniform(0.012, 0.03) * SR), int(0.008 * SR)
                end = min(n, a + closure)
                amp[a:end] *= 0.05
                b_end = min(n, end + burst)
                excitation[end:b_end] += rng.normal(0, 2.0, b_end - end)
    freqs, bws, gains = VOWELS[vowel]
    out = np.zeros(n)
    for f, bw, g in zip(freqs, bws, gains):
        f = min(f * formant_scale * rng.uniform(0.95, 1.05), 0.45 * SR)
        out += g * _resonator(excitation, f, bw * formant_scale)
    if vowel == "mm":
        out = sosfilt(butter(2, rng.uniform(500, 900), "low", fs=SR, output="sos"), out)
    if lowpass is not None:
        out = sosfilt(butter(2, lowpass, "low", fs=SR, output="sos"), out)
    if normalize_notes:
        # the formant filters make some pitches louder than others; even that out note by note, so the loudness
        # of each note is the one the performance asked for (round two)
        gain = np.ones(n)
        for nt in notes:
            a, b = int(nt["onset"] * SR), min(n, int(nt["offset"] * SR))
            if b - a > int(0.03 * SR) and nt["velocity"] > 0:
                r = float(np.sqrt(np.mean(out[a:b] ** 2)))
                if r > 0:
                    gain[a:b] = 1.0 / r
        k = int(0.02 * SR)
        gain = np.convolve(np.concatenate([np.full(k, gain[0]), gain, np.full(k, gain[-1])]), np.ones(k) / k, mode="same")[k:k + n]
        out = out * gain
    out *= amp
    # breath noise in the longer gaps between phrases
    breaths = 0
    for i in range(1, len(notes)):
        gap = notes[i]["onset"] - notes[i - 1]["offset"]
        if gap > 0.45 and rng.random() < 0.5:
            length = min(gap * 0.7, rng.uniform(0.2, 0.4))
            a = int((notes[i]["onset"] - length - 0.03) * SR)
            k = int(length * SR)
            bn = sosfilt(butter(2, [500, 4000], "band", fs=SR, output="sos"), rng.normal(0, 1, k)) * np.hanning(k)
            voice_rms = float(np.sqrt(np.mean(out[voiced_s] ** 2))) if np.any(voiced_s) else 1e-3
            out[a:a + k] += bn / (np.std(bn) + 1e-12) * voice_rms * rng.uniform(0.03, 0.15)
            breaths += 1
    return out, {"tilt": tilt, "breathiness": breath, "breaths_between_phrases": breaths, "timbre": timbre, "lowpass_hz": lowpass,
                 "formant_scale": formant_scale}


def render_breathy(rng, kind: str, cents_s, voiced_s, env_s) -> tuple[np.ndarray, dict]:
    n = len(cents_s)
    f0 = 440.0 * 2 ** ((np.nan_to_num(cents_s, nan=6000.0) - 6900.0) / 1200)
    phase = 2 * np.pi * np.cumsum(f0 / SR)
    noise = rng.normal(0, 1, n)
    if kind == "flute":
        amps = [1, 0.35, 0.18, 0.07, 0.03]
        tone = sum(a * np.sin((k + 1) * phase) for k, a in enumerate(amps))
        air = sosfilt(butter(2, [1500, 7000], "band", fs=SR, output="sos"), noise) * rng.uniform(0.05, 0.2)
    elif kind == "whistle":
        tone = np.sin(phase) + 0.04 * np.sin(2 * phase)
        air = noise * np.sin(phase) * rng.uniform(0.05, 0.15) + sosfilt(butter(2, 6000, "high", fs=SR, output="sos"), noise) * 0.02
    elif kind == "ocarina":
        tone = np.sin(phase) + 0.12 * np.sin(3 * phase) + 0.05 * np.sin(2 * phase)
        air = sosfilt(butter(2, [800, 3000], "band", fs=SR, output="sos"), noise) * rng.uniform(0.03, 0.1)
    else:
        raise ValueError(f"unknown breathy instrument {kind}")
    return (tone + air) * env_s, {"kind": kind}


def render_sampler(rng, bank, sound_id: str, notes: list[dict], cents_ctrl: np.ndarray, n_samples: int) -> tuple[np.ndarray, dict, np.ndarray]:
    """Each note from the nearest measured slot, resampled to the performed pitch at its onset.

    Returns audio, info and the stored performed pitch curve (the note's pitch plus the slot recording's own
    measured contour; where the tracker lost the pitch inside a note, the note's pitch itself)."""
    slots = bank.slots(sound_id)
    out = np.zeros(n_samples)
    stored = cents_ctrl.copy()
    release = rng.uniform(0.05, 0.25)
    used = []
    for nt in notes:
        if nt["velocity"] <= 0:
            used.append(None)
            continue
        c_idx = min(int(nt["onset"] * CTRL) + 5, len(cents_ctrl) - 1)
        target = float(cents_ctrl[c_idx])
        if not np.isfinite(target):
            raise ValueError(f"no performed pitch at a sampler note onset ({nt['onset']:.3f} s)")
        best = min(range(len(slots)), key=lambda i: abs(100 * slots[i]["sounding_midi"] + slots[i]["tuning_cents"] - target))
        s = slots[best]
        ratio = 2 ** ((target - (100 * s["sounding_midi"] + s["tuning_cents"])) / 1200)
        src = bank.slot_audio(sound_id, best)
        length = int((nt["offset"] - nt["onset"] + release) * SR)
        length = min(length, int((len(src) - 2) / ratio))
        pos = np.arange(length) * ratio
        seg = np.interp(pos, np.arange(len(src)), src)
        # the stored performed pitch over the note: the slot's own contour, time-scaled by the resampling
        contour = bank.slot_contour(sound_id, best)
        a_c, b_c = int(nt["onset"] * CTRL), min(len(stored), int(nt["offset"] * CTRL))
        if b_c > a_c:
            src_t = (np.arange(b_c - a_c) / CTRL) * ratio  # seconds into the slot recording
            dev = np.interp(src_t, np.arange(len(contour)) * 0.01, np.nan_to_num(contour, nan=0.0))
            stored[a_c:b_c] = target + dev
        rel = min(int(release * SR), length)
        if rel > 0:
            seg[-rel:] *= 0.5 + 0.5 * np.cos(np.pi * np.arange(rel) / rel)
        gain = 0.1 / max(s["rms"], 1e-4) * nt["velocity"] ** 1.5
        a = int(nt["onset"] * SR)
        end = min(n_samples, a + length)
        out[a:end] += seg[: end - a] * gain
        used.append({"slot_sounding_midi": s["sounding_midi"], "shift_cents": round(1200 * math.log2(ratio), 1)})
    return out, {"release_s": release, "slots": used}, stored


# --------------------------------------------------------------------------------------------------------
# Pollution
# --------------------------------------------------------------------------------------------------------

POLLUTION_LEVELS = ["none", "light", "medium", "heavy"]
POLLUTION_P = [0.15, 0.30, 0.30, 0.25]


def pink_noise(rng, n: int) -> np.ndarray:
    X = np.fft.rfft(rng.normal(0, 1, n))
    f = np.arange(len(X))
    X[1:] /= np.sqrt(f[1:])
    X[0] = 0
    y = np.fft.irfft(X, n)
    return y / (np.std(y) + 1e-12)


def chatter_noise(rng, n: int) -> np.ndarray:
    """Babble-like background: several noise 'talkers' through formant pairs, with irregular syllable envelopes."""
    out = np.zeros(n)
    for _ in range(int(rng.integers(3, 8))):
        src = pink_noise(rng, n)
        v = rng.choice(list(VOWELS))
        f1, f2 = VOWELS[v][0][:2]
        sc = rng.uniform(0.9, 1.3)
        y = _resonator(src, f1 * sc, 120) + 0.6 * _resonator(src, f2 * sc, 150)
        # irregular syllables: random gaps, never a steady rate
        env = np.zeros(n)
        pos = int(rng.uniform(0, 0.3) * SR)
        while pos < n:
            length = int(rng.uniform(0.08, 0.3) * SR)
            k = min(length, n - pos)
            env[pos:pos + k] = np.hanning(length)[:k] * rng.uniform(0.3, 1)
            pos += length + int(rng.exponential(0.12) * SR)
        out += y * env
    return out / (np.std(out) + 1e-12)


def hum_noise(rng, n: int) -> np.ndarray:
    base = 50.0 if rng.random() < 0.5 else 60.0
    t = np.arange(n) / SR
    y = sum((1 / k) * np.sin(2 * np.pi * base * k * t + rng.uniform(0, 6.28)) for k in range(1, 8))
    return y / (np.std(y) + 1e-12)


def pollute(rng, x: np.ndarray, level: str) -> tuple[np.ndarray, dict]:
    import pedalboard as pb

    li = POLLUTION_LEVELS.index(level)
    p: dict = {"level": level}
    x = x / (np.max(np.abs(x)) + 1e-9) * 0.5
    y = x.astype(np.float32)
    chain = []
    if li >= 1 and rng.random() < [0, 0.1, 0.2, 0.35][li]:
        drive = float(rng.uniform(4, [0, 10, 16, 26][li]))
        chain.append(pb.Distortion(drive_db=drive))
        p["distortion_drive_db"] = drive
    if rng.random() < [0.1, 0.4, 0.55, 0.6][li]:
        thr, ratio = float(rng.uniform(-32, -10)), float(rng.uniform(2, 8))
        chain.append(pb.Compressor(threshold_db=thr, ratio=ratio, attack_ms=float(rng.uniform(2, 20)), release_ms=float(rng.uniform(50, 250))))
        p["compressor"] = {"threshold_db": thr, "ratio": ratio}
    if rng.random() < [0.1, 0.5, 0.7, 0.8][li]:
        room = float(rng.uniform(0.05, [0.3, 0.5, 0.7, 0.9][li]))
        wet = float(rng.uniform(0.04, [0.12, 0.25, 0.35, 0.45][li]))
        chain.append(pb.Reverb(room_size=room, wet_level=wet, dry_level=1 - wet * 0.5, damping=float(rng.uniform(0.2, 0.8))))
        p["reverb"] = {"room_size": room, "wet": wet}
    if chain:
        y = pb.Pedalboard(chain)(y, SR)
    y = y.astype(np.float64)
    if li >= 1:
        snr_lo, snr_hi = [(0, 0), (30, 45), (18, 30), (4, 18)][li]
        kinds = list(rng.choice(["white", "pink", "hum", "chatter", "room"], size=1 if li < 3 or rng.random() < 0.5 else 2, replace=False))
        sig_rms = np.sqrt(np.mean(y[np.abs(y) > 1e-4] ** 2)) if np.any(np.abs(y) > 1e-4) else 1e-3
        noise_tot = np.zeros_like(y)
        for k in kinds:
            nz = {"white": lambda: rng.normal(0, 1, len(y)), "pink": lambda: pink_noise(rng, len(y)), "hum": lambda: hum_noise(rng, len(y)),
                  "chatter": lambda: chatter_noise(rng, len(y)), "room": lambda: sosfilt(butter(1, 300, "low", fs=SR, output="sos"), pink_noise(rng, len(y))) * 3}[k]()
            nz = nz / (np.std(nz) + 1e-12)
            snr = float(rng.uniform(snr_lo, snr_hi))
            noise_tot += nz * sig_rms * 10 ** (-snr / 20)
            p.setdefault("noise", []).append({"kind": str(k), "snr_db": snr})
        y = y + noise_tot
    if li >= 1 and rng.random() < [0, 0.2, 0.35, 0.5][li]:
        lo, hi = float(rng.uniform(120, 250)), float(rng.uniform(3400, 7000))
        y = sosfilt(butter(4, [lo, hi], "band", fs=SR, output="sos"), y)
        y = y / (np.max(np.abs(y)) + 1e-9)
        clip_db = float(rng.uniform(-6, -1))
        thr = 10 ** (clip_db / 20)
        y = np.clip(y * 1.2, -thr, thr)
        codec = "mp3" if rng.random() < 0.6 else "gsm"
        y32 = y.astype(np.float32)
        if codec == "mp3":
            q = float(rng.uniform(6, 9.5))
            y32 = pb.Pedalboard([pb.MP3Compressor(vbr_quality=q)])(y32, SR)
        else:
            y32 = pb.Pedalboard([pb.GSMFullRateCompressor()])(y32, SR)
        y = y32.astype(np.float64)[: len(x)]
        if len(y) < len(x):
            y = np.pad(y, (0, len(x) - len(y)))
        p["phone"] = {"band_hz": [lo, hi], "clip_db": clip_db, "codec": codec}
    peak_db = float(rng.uniform(-25, -1))
    y = y / (np.max(np.abs(y)) + 1e-9) * 10 ** (peak_db / 20)
    p["peak_dbfs"] = peak_db
    return np.clip(y, -1, 1), p
