"""Round two of the generator: real-hum statistics, real rhythms for procedural seeds, SoulX-Singer voices.

What changed from round one (hum_beats/generate.py, which made the round-one data and stays as it was):
  * metre and tempo follow real hums (HumTrans train): 4/4 55%, 2/4 15%, 3/4 20%, 6/8 10%; tempo 75% drawn
    from the HumTrans train piece tempos (+-5%), 25% uniform over 60-200 BPM;
  * no rubato: the tempo map is steady; timing, duration, loudness and pitch deviations come from the
    deviation model fitted on real hums (hum_beats/deviation.py); 10% of clips keep perfect timing;
  * procedural seeds take their rhythm (rests and repeated bars included) from precedent melodies of the
    same split, with small metrical edits, and get a new pitch line (music.melodize);
  * a SoulX-Singer share: sung English or Chinese lyrics, or hummed / nonsense syllables, five prompt voices
    (one, yue_target, only in test-unseen), the performed pitch curve imposed as SoulX's f0, our performed
    note times as its note durations. SoulX clips are made in three steps: write job -> worker renders ->
    finish (alignment check, pollution, labels).
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import soundfile as sf
import soxr

from . import music
from .deviation import DeviationModel, perform, pitch_curve_from_contours
from .generate import _json_default, choose_lead, clip_melody, finish_notes, pick, seed_of, transpose_for, write_midi
from .generate import precedent as g1_precedent
from .music import METERS, Score
from .render import (CTRL, POLLUTION_LEVELS, POLLUTION_P, VOICE_TYPES, loudness_curve, pollute, render_breathy, render_sampler,
                     render_voice, to_audio_rate)
from .sounds import SR, SoundBank

GENERATOR_VERSION = "2b"
DEV_DIR = Path("/mnt/d/casperaki-data/hum-beats/deviation-model")
METER_P = {"4/4": 0.55, "2/4": 0.15, "3/4": 0.20, "6/8": 0.10}
SOULX_PROMPTS = {"en_prompt": 64.9, "zh_prompt": 65.9, "en_target": 64.9, "zh_target": 53.0}
SOULX_UNSEEN_PROMPTS = {"yue_target": 56.1}
SYLLABLES = {"la": "en_L-AA1", "na": "en_N-AA1", "doo": "en_D-UW1", "da": "en_D-AA1", "mm": "en_M", "oo": "en_UW1", "ah": "en_AA1"}
EN_WORDS = ("love heart night day light time home way dream sky fire rain sun moon star eyes soul mind life road "
            "sea wind tree song stay go run fly fall rise hold know feel see say be free gone away there here now "
            "down up on in out by my you me we all one more still slow fast cold warm blue gold true new old young "
            "back side long far near wild calm bright dark deep high low sweet kind brave tears smile hand face "
            "door wall street town world dance sing call cry wait hope need want take give make break shine burn "
            "turn learn yes no oh so come home lost found last first").split()


def _en_phonemes() -> dict:
    import cmudict
    d = cmudict.dict()
    out = {}
    for w in EN_WORDS:
        if w not in d:
            raise KeyError(f"'{w}' is not in the CMU pronouncing dictionary")
        out[w] = "en_" + "-".join(d[w][0])
    return out


def _zh_syllables(phone_set_path: Path) -> list[str]:
    return [p for p in json.loads(phone_set_path.read_text()) if p.startswith("zh_") and p[-1].isdigit()]


def load_split_info() -> dict:
    return json.loads((DEV_DIR / "split.json").read_text())


def make_plan2(counts: dict, soulx_share: dict, plan_seed: int = 2026) -> list[dict]:
    """Rows for round two. Precedent families keep round one's split assignment (same permutation), so a
    melody never crosses splits across both rounds; procedural families are new seeds (proc2-*) whose rhythm
    donors are precedents of the same split."""
    rng = np.random.default_rng(plan_seed)
    fams = music.load_precedent_families()
    order = rng.permutation(len(fams))
    shares = {"dev": 0.04, "test": 0.04, "test-unseen": 0.025}
    by_split, pos = {}, 0
    for split, share in shares.items():
        k = int(round(share * len(fams)))
        by_split[split] = [fams[i]["family"] for i in order[pos:pos + k]]
        pos += k
    by_split["train"] = [fams[i]["family"] for i in order[pos:]]
    prng = np.random.default_rng(plan_seed + 2)
    rows = []
    for split, n in counts.items():
        pf = by_split[split]
        for i in range(n):
            cid = f"r2-{split}-{i:05d}"
            render = "soulx" if prng.random() < soulx_share[split] else "synth"
            seed = seed_of(plan_seed, "r2", cid)
            if i % 2 == 0:
                rows.append({"clip_id": cid, "split": split, "family": pf[(i // 2) % len(pf)], "source": "precedent", "seed": seed, "render": render})
            else:
                donors = [pf[int(prng.integers(len(pf)))], pf[int(prng.integers(len(pf)))]]
                rows.append({"clip_id": cid, "split": split, "family": f"proc2-{split}-{i:05d}", "source": "procedural", "seed": seed,
                             "render": render, "rhythm_donors": donors})
    return rows


class Context:
    """Everything a worker needs once: sound bank, deviation model, tempo list, lyric banks."""

    def __init__(self, cache_dir: Path, soulx_repo: Path):
        self.bank = SoundBank(cache_dir)
        split = load_split_info()
        self.dev = DeviationModel(DEV_DIR / "humtrans-train", set(split["fit_pieces"]))
        self.tempos = np.array(json.loads((DEV_DIR / "humtrans-train-tempos.json").read_text())["per_piece"])
        self.densities = np.array(json.loads((DEV_DIR / "humtrans-train-density.json").read_text())["notes_per_beat"])
        self.en = _en_phonemes()
        self.zh = _zh_syllables(soulx_repo / "soulxsinger" / "utils" / "phoneme" / "phone_set.json")


def draw_tempo(rng, tempos: np.ndarray) -> tuple[float, str]:
    if rng.random() < 0.75:
        return float(np.clip(tempos[int(rng.integers(len(tempos)))] * rng.uniform(0.95, 1.05), 60, 200)), "humtrans-like"
    return float(rng.uniform(60, 200)), "uniform"


def melody_density(row: dict, meter: str) -> float:
    """Notes per beat of the source melody (the precedent, or the procedural seed's first rhythm donor)."""
    fam = row["family"] if row["source"] == "precedent" else row["rhythm_donors"][0]
    notes, _ = music.retime_precedent(g1_precedent(fam)["notes"], meter)
    span = (max(b for _, b, _ in notes) - min(a for a, _, _ in notes)) / METERS[meter][1]
    return len(notes) / span


def time_scale(rng, density: float, densities: np.ndarray) -> tuple[int, float]:
    """1 (as written) or 2 (half-time: every duration doubled, half the notes per beat), whichever puts the
    melody closer to a note density drawn from real hums (HumTrans train, notes per beat, +-10%)."""
    target = float(densities[int(rng.integers(len(densities)))] * rng.uniform(0.9, 1.1))
    return (2 if density / 2 >= 0.9 * target else 1), target


def thin_to_density(rng, notes, beat_q: float, bar_q: float, target: float):
    """Bring a melody toward a target note density: merge short neighbouring notes when it is too dense,
    split long notes when it is too sparse (pattern-consistent per bar, see music.mutate_rhythm)."""
    if len(notes) < 2:
        return notes
    span = (max(b for _, b, _ in notes) - min(a for a, _, _ in notes)) / beat_q
    r = target / (len(notes) / span)
    if r < 1:
        return music.mutate_rhythm(rng, sorted(notes), beat_q, bar_q, p_merge=float(min(0.95, 2 * (1 - r))), p_split=0.0)
    return music.mutate_rhythm(rng, sorted(notes), beat_q, bar_q, p_merge=0.0, p_split=float(min(0.9, r - 1)))


def procedural_melody(rng, row, meter, n_bars, style, bpm, start_mode):
    bar_q, beat_q = METERS[meter]
    a_row = {**row, "source": "precedent", "family": row["rhythm_donors"][0]}
    notes, info = clip_melody(rng, a_row, meter, n_bars, style, bpm, start_mode)
    info = {"rhythm_donor_a": row["rhythm_donors"][0], "rhythm_donor_a_window_bar": info.get("window_start_bar")}
    if n_bars >= 4 and rng.random() < 0.25:
        b_row = {**row, "source": "precedent", "family": row["rhythm_donors"][1]}
        b_notes, b_info = clip_melody(rng, b_row, meter, n_bars, style, bpm, "downbeat")
        half = (n_bars // 2) * bar_q
        notes = [x for x in notes if x[0] < half] + [x for x in b_notes if x[0] >= half]
        info["rhythm_donor_b"] = row["rhythm_donors"][1]
    if not notes:
        return [], info
    notes = music.mutate_rhythm(rng, sorted(notes), beat_q, bar_q)
    notes, minfo = music.melodize(rng, notes, beat_q)
    info.update(minfo)
    return notes, info


def make_state(row: dict, ctx: Context) -> dict:
    """Melody, timing, performance and pitch curve for one clip (everything before the audio)."""
    rng = np.random.default_rng(row["seed"])
    meter = pick(rng, list(METER_P), list(METER_P.values()))
    bar_q, beat_q = METERS[meter]
    n_bars = pick(rng, [2, 4, 8])
    bpm, tempo_source = draw_tempo(rng, ctx.tempos)
    style = pick(rng, ["straight", "syncopated"], [0.75, 0.25]) if meter == "6/8" else pick(rng, ["straight", "swung", "syncopated"], [0.6, 0.15, 0.25])
    timing = pick(rng, ["real", "perfect"], [0.9, 0.1])
    if meter in ("6/8", "2/4") and n_bars == 2:
        start_mode = pick(rng, ["downbeat", "pickup"], [0.43, 0.57])
    else:
        start_mode = pick(rng, ["downbeat", "pickup", "midbar"], [0.3, 0.4, 0.3])
    pause = pick(rng, [None, "beat", "bar"], [0.7, 0.18, 0.12])
    pollution = pick(rng, POLLUTION_LEVELS, POLLUTION_P)
    if row["render"] == "soulx":
        prompts = SOULX_UNSEEN_PROMPTS if row["split"] == "test-unseen" else SOULX_PROMPTS
        prompt = pick(rng, list(prompts))
        text = pick(rng, ["en_lyrics", "zh_lyrics", "syllables"], [0.35, 0.3, 0.35])
        syl = pick(rng, list(SYLLABLES)) if text == "syllables" else None
        lead = {"kind": "soulx", "prompt": prompt, "text": text, "syllable": syl, "group": "soulx", "timbre": f"soulx-{prompt}",
                "median_midi": prompts[prompt] + float(rng.uniform(-3, 4))}  # SoulX will not follow a voice much below its prompt
    else:
        lead = choose_lead(rng, row["split"], ctx.bank)
    scale, target_density = time_scale(rng, melody_density(row, meter), ctx.densities)
    drawn_bars, found = n_bars, False
    while not found:
        for _ in range(20):
            window = max(1, n_bars // scale)
            if row["source"] == "procedural":
                raw, minfo = procedural_melody(rng, row, meter, window, style, bpm, start_mode)
            else:
                raw, minfo = clip_melody(rng, row, meter, window, style, bpm, start_mode)
            raw = thin_to_density(rng, [(a * scale, b * scale, m) for a, b, m in raw], beat_q, bar_q, target_density)
            minfo = {**minfo, "time_scale": scale, "target_notes_per_beat": round(target_density, 3)}
            notes, finfo = finish_notes(rng, raw, meter, style, n_bars, bpm, pause)
            if len(notes) >= 4:
                span = math.floor((min(max(n.q_off for n in notes), n_bars * bar_q) - 1e-6) / beat_q) - math.ceil((min(n.q_on for n in notes) - 1e-6) / beat_q) + 1
                if span >= 3:
                    found = True
                    break
        if not found:
            if n_bars == 8:
                raise ValueError(f"{row['clip_id']}: no melody with at least 4 notes over at least 3 beats, even at 8 bars")
            n_bars = {2: 4, 4: 8}[n_bars]
    if n_bars != drawn_bars:
        minfo["n_bars_raised_from"] = drawn_bars
    shift = transpose_for(rng, notes, lead)
    score = Score(meter, n_bars, notes, {"source": row["source"], "family": row["family"], **minfo, **finfo})
    q_lo = math.floor((min(n.q_on for n in notes) - 3 * bar_q) * 48) / 48
    q_hi = n_bars * bar_q + 3 * bar_q
    tmap, tparams = music.build_tempo_map(rng, score, bpm, "perfect", q_lo, q_hi, {"tempo": 0.0})
    perf, pparams = perform(ctx.dev, rng, score, tmap, perfect_timing=timing == "perfect")
    lead_in, tail = float(rng.uniform(0.1, 1.5)), float(rng.uniform(0.3, 1.5))
    anchor = min(perf[0]["onset"], min(p["nominal_onset"] for p in perf))
    q_start = math.floor(float(tmap.position(anchor - lead_in)) * 8) / 8
    t0 = float(tmap.time(q_start))
    for p in perf:
        for k in ("nominal_onset", "nominal_offset", "onset", "offset"):
            p[k] -= t0
    dur = max(p["offset"] for p in perf) + 0.3 + tail
    expressive = lead["kind"] in ("voice", "breathy", "soulx") or lead["group"] == "vocal_sample"
    cents = pitch_curve_from_contours(perf, dur, pparams, expressive)
    return {"row": row, "rng_state": rng.bit_generator.state, "meter": meter, "n_bars": n_bars, "bpm": bpm, "tempo_source": tempo_source,
            "style": style, "timing": timing, "start_mode": start_mode, "pollution_level": pollution, "lead": lead, "transpose": shift,
            "score": score, "tmap": tmap, "t0": t0, "perf": perf, "perf_params": pparams, "dur": dur, "cents": cents,
            "lead_in": perf[0]["onset"], "tail": tail}


def _held(cents: np.ndarray) -> np.ndarray:
    held = cents.copy()
    idx = np.flatnonzero(~np.isnan(held))
    if len(idx) == 0:
        raise ValueError("empty pitch curve")
    n = len(held)
    prev_i = np.maximum.accumulate(np.where(~np.isnan(held), np.arange(n), -1))
    nxt = np.where(~np.isnan(held), np.arange(n), n)
    next_i = np.minimum.accumulate(nxt[::-1])[::-1]
    gap = np.isnan(held)
    use_next = gap & ((prev_i < 0) | ((next_i < n) & (np.arange(n) - prev_i > next_i - np.arange(n))))
    held[use_next] = held[next_i[use_next]]
    use_prev = gap & ~use_next
    held[use_prev] = held[prev_i[use_prev]]
    return held


def render_synth(st: dict, ctx: Context) -> tuple[np.ndarray, dict, np.ndarray]:
    rng = np.random.default_rng()
    rng.bit_generator.state = st["rng_state"]
    lead, perf, dur, cents = st["lead"], st["perf"], st["dur"], st["cents"]
    n_samples = int(dur * SR)
    if lead["kind"] == "sampler":
        audio, sinfo, stored = render_sampler(rng, ctx.bank, lead["sound_id"], perf, cents, n_samples)
    else:
        attack, release = float(rng.uniform(0.015, 0.12)), float(rng.uniform(0.03, 0.12))
        env_s = to_audio_rate(loudness_curve(perf, dur, attack, release, legato_dip=float(rng.uniform(0, 0.5))), n_samples)
        cents_s = to_audio_rate(_held(cents), n_samples)
        voiced_s = env_s > 1e-4
        if lead["kind"] == "voice":
            audio, sinfo = render_voice(rng, cents_s, voiced_s, env_s, lead["vowel"], VOICE_TYPES[lead["voice_type"]][1], perf, dur, st["row"]["split"] == "test-unseen", normalize_notes=True)
        else:
            audio, sinfo = render_breathy(rng, lead["instrument"], cents_s, voiced_s, env_s)
        sinfo.update(attack_s=attack, release_s=release)
        stored = cents
    st["rng_state"] = rng.bit_generator.state
    return np.asarray(audio, dtype=np.float64), sinfo, stored


def soulx_job(st: dict, ctx: Context) -> dict:
    """Note sequence (rests included) on the clip timeline, lyrics, and the f0 curve at 50 frames per second."""
    rng = np.random.default_rng()
    rng.bit_generator.state = st["rng_state"]
    lead, perf, dur, cents = st["lead"], st["perf"], st["dur"], st["cents"]
    phon, durs, pitch, ntype, words = [], [], [], [], []
    t = 0.0
    for p in perf:
        if p["onset"] > t + 1e-3:
            phon.append("<SP>"); durs.append(p["onset"] - t); pitch.append(0); ntype.append(1); words.append("")
        if lead["text"] == "syllables":
            ph, w = SYLLABLES[lead["syllable"]], lead["syllable"]
        elif lead["text"] == "en_lyrics":
            w = str(rng.choice(EN_WORDS)); ph = ctx.en[w]
        else:
            ph = str(rng.choice(ctx.zh)); w = ph
        phon.append(ph); durs.append(p["offset"] - p["onset"]); pitch.append(int(p["midi"])); ntype.append(2); words.append(w)
        t = p["offset"]
    phon.append("<SP>"); durs.append(dur - t); pitch.append(0); ntype.append(1); words.append("")
    n = int(round(sum(durs) * 50))
    times = np.arange(n) / 50.0
    c = np.interp(times, np.arange(len(cents)) / CTRL, cents)
    f0 = np.where(np.isfinite(c), 440.0 * 2 ** ((np.nan_to_num(c, nan=6900) - 6900) / 1200), 0.0)
    st["rng_state"] = rng.bit_generator.state
    st["lyrics"] = words
    return {"prompt": lead["prompt"], "language": "Mandarin" if lead["text"] == "zh_lyrics" else "English", "phoneme": phon,
            "duration": durs, "note_pitch": pitch, "note_type": ntype, "f0": f0.round(2).tolist()}


def check_soulx_pitch(audio22: np.ndarray, cents: np.ndarray) -> dict:
    """How closely SoulX sang the f0 it was given: pYIN on the output against the stored curve."""
    import librosa
    f0, v, _ = librosa.pyin(audio22.astype(np.float32), fmin=50, fmax=1200, sr=SR, frame_length=2048, hop_length=220)
    t = librosa.times_like(f0, sr=SR, hop_length=220)
    st = np.interp(t, np.arange(len(cents)) / CTRL, cents, left=np.nan, right=np.nan)
    ok = v & np.isfinite(st) & np.isfinite(f0)
    if ok.sum() < 20:
        return {"frames": int(ok.sum()), "octave_off": None, "within_50_cents": None}
    d = 1200 * np.log2(f0[ok] / 440) + 6900 - st[ok]
    return {"frames": int(ok.sum()), "octave_off": float(np.mean(np.abs(d) > 600)), "within_50_cents": float(np.mean(np.abs(d) < 50))}


def check_soulx_alignment(audio22: np.ndarray, perf: list[dict]) -> dict:
    """Where SoulX actually started the notes, against the performed onsets we asked for."""
    import librosa
    on = librosa.onset.onset_detect(y=audio22.astype(np.float32), sr=SR, hop_length=110, units="time", backtrack=False)
    errs = []
    prev = -1.0
    for p in perf:
        if p["onset"] - prev < 0.2:
            prev = p["onset"]
            continue  # too close to the previous note for the onset detector
        prev = p["onset"]
        errs.append(float(on[np.argmin(np.abs(on - p["onset"]))] - p["onset"]) if len(on) else np.nan)
    e = np.array(errs)
    ok = np.isfinite(e)
    return {"checked_notes": int(ok.sum()), "median_ms": float(np.median(e[ok]) * 1000) if ok.any() else None,
            "within_70ms": float(np.mean(np.abs(e[ok]) < 0.07)) if ok.any() else 0.0}


def finish(st: dict, audio: np.ndarray, sinfo: dict, stored: np.ndarray, out_dir: Path) -> dict:
    """Pollution, labels and files (the same formats as round one)."""
    rng = np.random.default_rng()
    rng.bit_generator.state = st["rng_state"]
    row, score, tmap, t0, perf, dur = st["row"], st["score"], st["tmap"], st["t0"], st["perf"], st["dur"]
    meter, n_bars = st["meter"], st["n_bars"]
    bar_q, beat_q = METERS[meter]
    if not np.all(np.isfinite(audio)) or np.max(np.abs(audio)) < 1e-6:
        raise ValueError(f"{row['clip_id']}: rendered audio is silent or not finite")
    n_samples = int(dur * SR)
    audio = audio[:n_samples] if len(audio) >= n_samples else np.pad(audio, (0, n_samples - len(audio)))
    audio, fx = pollute(rng, audio, st["pollution_level"])
    notes = score.notes
    first_q, last_q = min(n.q_on for n in notes), max(n.q_off for n in notes)
    k0 = math.ceil((first_q - 1e-6) / beat_q)
    k1 = math.floor((min(last_q, n_bars * bar_q) - 1e-6) / beat_q)
    beat_q_pos = np.arange(k0, k1 + 1) * beat_q
    beat_t = tmap.time(beat_q_pos) - t0
    beat_num = (np.round((beat_q_pos % bar_q) / beat_q).astype(int) % int(round(bar_q / beat_q))) + 1
    keep = (beat_t >= 0) & (beat_t <= dur)
    beat_q_pos, beat_t, beat_num = beat_q_pos[keep], beat_t[keep], beat_num[keep]
    if len(beat_t) < 3:
        raise ValueError(f"{row['clip_id']}: fewer than 3 labelled beats")
    cid = row["clip_id"]
    out_dir.mkdir(parents=True, exist_ok=True)
    sf.write(out_dir / f"{cid}.wav", audio.astype(np.float32), SR, subtype="PCM_16")
    with open(out_dir / f"{cid}.beats", "w") as f:
        f.writelines(f"{t:.5f}\t{n}\n" for t, n in zip(beat_t, beat_num))
    hop = int(round(0.01 * CTRL))
    np.savez_compressed(out_dir / f"{cid}.pitch.npz", time_s=(np.arange(0, len(stored), hop) / CTRL).astype(np.float32), cents=stored[::hop].astype(np.float32))
    write_midi(out_dir / f"{cid}.mid", perf, tmap, t0, meter, dur)
    note_rows = []
    lyrics = st.get("lyrics")
    for i, p in enumerate(perf):
        c = np.asarray(p["contour"], dtype=float)
        note_rows.append({
            "part": "lead", "midi": p["midi"], "q_on": round(p["q_on"], 5), "q_off": round(p["q_off"], 5),
            "bar": int(math.floor(p["q_on"] / bar_q)), "beat_in_bar": round((p["q_on"] % bar_q) / beat_q + 1, 4),
            "onset": round(p["nominal_onset"], 5), "offset": round(p["nominal_offset"], 5),
            "performed_onset": round(p["onset"], 5), "performed_offset": round(p["offset"], 5),
            "velocity": round(p["velocity"], 4), "articulation": p["articulation"], "swallowed": None, "phrase_end": p["phrase_end"],
            "pitch": {"contour_source": p["contour_src"], "median_deviation_cents": round(float(np.nanmedian(c)) * p["pitch_scale"], 1) if np.isfinite(c).any() else None},
            **({"lyric": lyrics[i]} if lyrics else {}),
        })
    meta = {
        "clip_id": cid, "split": row["split"], "family": row["family"], "seed": row["seed"], "generator_version": GENERATOR_VERSION,
        "sample_rate": SR, "duration_s": round(dur, 4), "meter": meter, "beats_per_bar": int(round(bar_q / beat_q)),
        "beat_unit": "dotted quarter" if meter == "6/8" else "quarter", "n_bars": n_bars, "bpm": st["bpm"], "tempo_source": st["tempo_source"],
        "style": st["style"], "timing": st["timing"], "start_mode": st["start_mode"], "pollution": fx, "lead": st["lead"],
        "transpose": st["transpose"], "lead_in_s": st["lead_in"], "tail_s": st["tail"], "score": score.source,
        "performance": st["perf_params"], "render": sinfo,
        "beats": [{"time": round(float(t), 5), "beat_in_bar": int(n), "q": float(q)} for t, n, q in zip(beat_t, beat_num, beat_q_pos)],
        "tempo_map": {"q": tmap.q[::12].round(4).tolist(), "time_s": (tmap.t[::12] - t0).round(5).tolist()},
        "notes": note_rows, "files": {"audio": f"{cid}.wav", "beats": f"{cid}.beats", "midi": f"{cid}.mid", "pitch": f"{cid}.pitch.npz"},
    }
    (out_dir / f"{cid}.json").write_text(json.dumps(meta, default=_json_default))
    return meta


def soulx_audio(path: Path) -> np.ndarray:
    y, sr = sf.read(path, dtype="float32")
    if sr != 24000:
        raise ValueError(f"{path}: expected 24 kHz SoulX output, got {sr}")
    return soxr.resample(y, 24000, SR).astype(np.float64)
