"""Adapter: ace-layer (one extra instrument part for a finished song, played by ACE-Step 1.5 "lego").

Given the song's rendered mix (a WAV on local disk), ACE-Step's base model runs the `lego` task over the WHOLE file
and generates ONE part (a guitar, strings, brass ...) that fits the song; the job returns that part alone, as a WAV of
exactly the source's length and sample rate, stereo. Design: docs/superpowers/specs/2026-11-25-ace-layer-design.md;
the parameters are the spike's (apps/models/ace-vocal-tests/layer-spike/ace_run.py).

The base model (`acestep-v15-base`, without the 5 Hz language model) is loaded ONCE in `load` and stays on the GPU
(about 8 GB). It runs in ACE-Step's own venv (apps/models/services/ace-step/.venv) through its Python API, not
through ACE-Step's HTTP server (that is the separate `ace-step` adapter, on the turbo model).

POST /generate params (all required, no others accepted):
  src_wav    absolute path of the song's WAV (must exist; 10 s to 600 s, ACE-Step's supported range)
  track      guitar | strings | brass | woodwinds | keyboard | synth | fx | backing_vocals | vocals
  lyrics     (optional, sung parts only) the words, in ACE's lyrics format; without it every part is instrumental
  caption    plain description of the part (and the song), e.g. "acoustic guitar strumming, pop, 128 bpm, C major"
  bpm        number, 30..300
  key_scale  "<note>[#|b] major|minor", e.g. "C major", "F# minor"
  seed       int
Steps: read ("Read the song"), lego ("ACE writes the <track> part"), write ("Write the part").
  sections   (optional, sung parts only, instead of lyrics) rap per section (docs/superpowers/specs/
             2026-11-27-rap-vocals-design.md): [{name, start, end, lyrics}], seconds in the song, the section's lines.
             Each section is made on its own stretch of the song (made MIN_WINDOW_BARS long at least, its lines repeated
             to fill it), `takes` times, and
             the take whose separated vocal raps the words most clearly is kept (svc-vocals' venv:
             vocals/tools/pick_rap_take.py, BS-RoFormer + Whisper); rounds of `takes` until 40 % of the words are heard,
             MAX_RAP_TAKES at most. The result is silent outside the sections.
  takes      (with sections only) takes per round, 1..8
Steps: read, lego (or one rap_<name> per section), write.
Result file: layer.wav (32-bit float WAV). ACE-Step peak-normalises its output to -1 dBFS, so the part's level says
nothing about how loud it should sit in the mix: the caller sets the clip's level.
"""
from __future__ import annotations

import math
import os
import sys
import time
from pathlib import Path

SERVICES_DIR = Path(__file__).resolve().parents[2]
ACE_ROOT = SERVICES_DIR / "ace-step"
CHECKPOINT_FOLDER = "ACE-Step__Ace-Step1.5"
MODEL = "acestep-v15-base"

# The instruments the brain may ask for. ACE-Step's own list (acestep.constants.TRACK_NAMES) also has bass, drums,
# percussion and vocals: left out (the song has its own bass and drums; percussion copied our drums in the spike).
TRACKS = ("guitar", "strings", "brass", "woodwinds", "keyboard", "synth", "fx", "backing_vocals", "vocals")
# Parts that sing: they may be given words (`lyrics`, ACE's lyrics format, e.g. "[Chorus]\n(oh yeah)\n(ooh)").
VOCAL_TRACKS = ("backing_vocals", "vocals")
PARAMS = ("src_wav", "track", "caption", "bpm", "key_scale", "seed")
OPTIONAL_PARAMS = ("lyrics", "sections", "takes")
MIN_SECONDS = 10.0   # acestep.constants.DURATION_MIN
MAX_SECONDS = 600.0  # acestep.constants.DURATION_MAX (also the length of the model's silence latent: 15000 frames at 25 Hz)

# Rap per section (spike 2026-11-27, apps/models/ace-vocal-tests/rap): a take raps 0-90 % of its words (mean 45 %), so
# several are made and the clearest kept; fewer than half the words heard after MAX_RAP_TAKES fails the job.
MIN_RAP_RECALL = 0.4  # failed takes heard 0-33 % of their words, good ones 47-100 % (Whisper misses some rap)
# A section is made on 8 bars of song at least: over 4 bars (10 s at 128 bpm) ACE gave no voice at all in 12 takes,
# over 8 bars (the section, then the song after it) it rapped (Electric Daydream's bridge, 2026-11-27). The section's
# lines are repeated to fill the window (one line per RAP_BARS_PER_LINE bars); only the section's stretch is kept.
MIN_WINDOW_BARS = 8
RAP_BARS_PER_LINE = 2
MAX_RAP_TAKES = 12
MAX_TAKES_PER_ROUND = 8
VOCALS_PYTHON = SERVICES_DIR / "vocals" / ".venv" / "bin" / "python"
PICK_TOOL = SERVICES_DIR / "vocals" / "tools" / "pick_rap_take.py"

# The spike's settings (design doc, "What the spike showed").
ACE_SETTINGS = dict(
    task_type="lego",
    lyrics="[Instrumental]",
    instrumental=True,
    inference_steps=50,
    guidance_scale=7.0,
    shift=3.0,
    infer_method="ode",
    audio_cover_strength=1.0,
    timesignature="4",
    vocal_language="en",
    thinking=False,
    use_cot_metas=False,
    use_cot_caption=False,
    use_cot_language=False,
    # ACE's default (wavelet SNR correction on) makes the base model's output a drone that ignores its conditioning.
    dcw_enabled=False,
)

MANIFEST = {
    "id": "ace-layer",
    "label": "ACE layer (one instrument part over a song)",
    "description": "ACE-Step 1.5 base model, lego task: generates one instrument part that fits a rendered song.",
    "kind": "audio",
    "category": "model",
    "python": "3.12",
    # ACE-Step's own venv (created by the ace-step adapter's setup); this adapter never creates one.
    "venv": "../ace-step/.venv",
    "params": {
        "src_wav": {"type": "string", "required": True, "description": "absolute path of the song's WAV"},
        "track": {"type": "string", "required": True, "enum": list(TRACKS)},
        "caption": {"type": "string", "required": True},
        "lyrics": {"type": "string", "required": False},
        "bpm": {"type": "number", "required": True},
        "key_scale": {"type": "string", "required": True, "description": 'e.g. "C major", "A minor"'},
        "seed": {"type": "number", "required": True},
    },
}


def track_label(track: str) -> str:
    """How a track is named to people: "backing_vocals" -> "backing vocals"."""
    return track.replace("_", " ")


def lego_instruction(track: str) -> str:
    """ACE-Step's lego instruction for a track, written as ACE writes it (acestep/core/generation/handler/
    task_utils.py: TASK_INSTRUCTIONS["lego"].format(TRACK_NAME=track_name.upper()), e.g. BACKING_VOCALS)."""
    return f"Generate the {track.upper()} track based on the audio context:"


def check_params(params) -> dict:
    """The job's params, checked. Raises ValueError naming what is missing or wrong."""
    from acestep.constants import BPM_MAX, BPM_MIN, VALID_KEYSCALES

    if not isinstance(params, dict):
        raise ValueError(f"ace-layer: params must be a JSON object, got {type(params).__name__}")
    missing = [k for k in PARAMS if k not in params]
    if missing:
        raise ValueError(f"ace-layer: missing params {missing}; required: {list(PARAMS)}")
    unknown = sorted(set(params) - set(PARAMS) - set(OPTIONAL_PARAMS))
    if unknown:
        raise ValueError(f"ace-layer: unknown params {unknown}; accepted: {list(PARAMS + OPTIONAL_PARAMS)}")

    src = params["src_wav"]
    if not isinstance(src, str) or not os.path.isabs(src):
        raise ValueError(f"ace-layer: src_wav must be an absolute path, got {src!r}")
    if not os.path.isfile(src):
        raise ValueError(f"ace-layer: src_wav {src} does not exist")

    track = params["track"]
    if track not in TRACKS:
        raise ValueError(f"ace-layer: track {track!r} is not one of {list(TRACKS)}")

    caption = params["caption"]
    if not isinstance(caption, str) or not caption.strip():
        raise ValueError(f"ace-layer: caption must be a non-empty string, got {caption!r}")

    bpm = params["bpm"]
    if isinstance(bpm, bool) or not isinstance(bpm, (int, float)) or not math.isfinite(bpm):
        raise ValueError(f"ace-layer: bpm must be a number, got {bpm!r}")
    if not BPM_MIN <= bpm <= BPM_MAX:
        raise ValueError(f"ace-layer: bpm {bpm} is outside ACE-Step's range {BPM_MIN}..{BPM_MAX}")

    key = params["key_scale"]
    if key not in VALID_KEYSCALES:
        raise ValueError(f'ace-layer: key_scale {key!r} is not a key ACE-Step knows (e.g. "C major", "F# minor")')

    seed = params["seed"]
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise ValueError(f"ace-layer: seed must be an integer, got {seed!r}")

    sections = params.get("sections")
    takes = params.get("takes")
    if sections is not None:
        if track not in VOCAL_TRACKS:
            raise ValueError(f"ace-layer: sections are for sung parts ({list(VOCAL_TRACKS)}), not {track!r}")
        if "lyrics" in params:
            raise ValueError("ace-layer: give the words in each section's lyrics, not in lyrics, when sections are given")
        if not isinstance(sections, list) or not sections:
            raise ValueError(f"ace-layer: sections must be a non-empty list, got {sections!r}")
        checked = []
        for i, sec in enumerate(sections):
            if not isinstance(sec, dict) or set(sec) != {"name", "start", "end", "lyrics"}:
                raise ValueError(f"ace-layer: section {i} must be {{name, start, end, lyrics}}, got {sec!r}")
            name, start, end, words = sec["name"], sec["start"], sec["end"], sec["lyrics"]
            if not isinstance(name, str) or not name.strip():
                raise ValueError(f"ace-layer: section {i} has no name")
            for k, v in (("start", start), ("end", end)):
                if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0:
                    raise ValueError(f"ace-layer: section {name!r} {k} must be a number of seconds >= 0, got {v!r}")
            if end <= start:
                raise ValueError(f"ace-layer: section {name!r} ends ({end}) before it starts ({start})")
            if not isinstance(words, str) or not words.strip():
                raise ValueError(f"ace-layer: section {name!r} has no words (lyrics)")
            checked.append({"name": name, "start": float(start), "end": float(end), "lyrics": words.strip()})
        for a, b in zip(checked, checked[1:]):
            if b["start"] < a["end"]:
                raise ValueError(f"ace-layer: sections {a['name']!r} and {b['name']!r} overlap or are out of order")
        if isinstance(takes, bool) or not isinstance(takes, int) or not 1 <= takes <= MAX_TAKES_PER_ROUND:
            raise ValueError(f"ace-layer: takes must be an integer 1..{MAX_TAKES_PER_ROUND} with sections, got {takes!r}")
        sections = checked
    elif takes is not None:
        raise ValueError("ace-layer: takes are only for sections")

    lyrics = params.get("lyrics")
    if lyrics is not None:
        if track not in VOCAL_TRACKS:
            raise ValueError(f"ace-layer: lyrics are for sung parts ({list(VOCAL_TRACKS)}), not {track!r}")
        if not isinstance(lyrics, str) or not lyrics.strip():
            raise ValueError(f"ace-layer: lyrics must be a non-empty string, got {lyrics!r}")

    # ACE takes an integer bpm (GenerationParams.bpm: Optional[int]); the brain's tempo may be fractional.
    return {"src_wav": src, "track": track, "caption": caption.strip(), "bpm": int(round(bpm)),
            "key_scale": key, "seed": seed, **({"lyrics": lyrics.strip()} if lyrics is not None else {}),
            **({"sections": sections, "takes": takes} if sections is not None else {})}


def section_window(start: float, end: float, total: float, min_seconds: float = MIN_SECONDS) -> tuple[float, float]:
    """The stretch of the song a section is made on: the section, made min_seconds long at least by taking more of the
    song after it (or before it, at the song's end)."""
    if total < min_seconds:
        raise ValueError(f"ace-layer: the song is {total:.1f} s long; a section needs {min_seconds:.0f} s of song around it")
    if end > total + 1e-6:
        raise ValueError(f"ace-layer: a section ends at {end:.2f} s, after the song's end ({total:.2f} s)")
    if end - start >= min_seconds:
        return start, end
    we = min(total, start + min_seconds)
    return max(0.0, we - min_seconds), we


def window_seconds(bpm: float) -> float:
    """The least stretch of song a section is made on: MIN_WINDOW_BARS bars (4 beats), and MIN_SECONDS."""
    return max(MIN_SECONDS, MIN_WINDOW_BARS * 4 * 60 / bpm)


def rap_lyrics(lines: str, seconds: float, bpm: float, lead: float = 0.0) -> str:
    """ACE's lyrics for one section's rap over `seconds` of song: its lines under one verse tag (a section is made on
    its own), repeated to fill the stretch at one line per RAP_BARS_PER_LINE bars. `lead`: seconds of the window before
    the section (a window pulled back at the song's end); the cycle is turned so the section starts on its first line."""
    own = [l.strip() for l in lines.strip().splitlines() if l.strip()]
    if not own:
        raise ValueError("ace-layer: a section's rap has no lines")
    line_s = RAP_BARS_PER_LINE * 4 * 60 / bpm
    need = max(len(own), round(seconds / line_s))
    offset = round(lead / line_s)
    return "[Verse]\n" + "\n".join(own[(i - offset) % len(own)] for i in range(need))


def rank(score: dict) -> tuple[float, float]:
    """How takes compare (as the picker's best_take): words heard, then vocal over what is left of the backing."""
    v, k = score["vocal_db"], score["backing_db"]
    return score["recall"], (-math.inf if v is None else v - (-math.inf if k is None else k))


def pick_rap_take(takes: list[str], words: str, start: float, end: float, out: str) -> dict:
    """Runs vocals/tools/pick_rap_take.py (svc-vocals' venv) on one section's takes: {"best", "takes": [scores]}."""
    import json
    import subprocess

    for need in (VOCALS_PYTHON, PICK_TOOL):
        if not need.exists():
            raise RuntimeError(f"ace-layer: the rap picker needs {need}")
    req = json.dumps({"takes": takes, "words": words, "start": start, "end": end, "out": out})
    r = subprocess.run([str(VOCALS_PYTHON), str(PICK_TOOL)], input=req, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"ace-layer: the rap picker failed ({r.returncode}): {r.stderr.strip()[-1500:]}")
    lines = [l for l in r.stdout.splitlines() if l.strip()]
    if not lines:
        raise RuntimeError("ace-layer: the rap picker printed nothing")
    return json.loads(lines[-1])


def fit_length(audio, n: int):
    """(channels, samples) audio trimmed or zero-padded at the end to exactly n samples."""
    import numpy as np

    if audio.shape[1] >= n:
        return audio[:, :n]
    return np.pad(audio, ((0, 0), (0, n - audio.shape[1])))


def level_db(x) -> float:
    import numpy as np

    rms = float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))
    if rms == 0.0:
        return -math.inf
    return 20 * math.log10(rms)


def minutes(seconds: float) -> str:
    s = int(round(seconds))
    return f"{s // 60}:{s % 60:02d}"


def load(ctx):
    if ctx.model_dir is None:
        raise RuntimeError("ace-layer: no --models-dir given")
    ckpt = Path(ctx.model_dir) / CHECKPOINT_FOLDER
    for need in (ckpt / MODEL / "model.safetensors", ckpt / MODEL / "silence_latent.pt", ckpt / "vae",
                 ckpt / "Qwen3-Embedding-0.6B"):
        if not need.exists():
            raise RuntimeError(f"ace-layer: ACE-Step weights incomplete, missing {need}")
    # ACE-Step reads its weights folder from this variable when it initialises.
    os.environ["ACESTEP_CHECKPOINTS_DIR"] = str(ckpt)
    if str(ACE_ROOT) not in sys.path:
        sys.path.insert(0, str(ACE_ROOT))

    from acestep.constants import TRACK_NAMES
    from acestep.handler import AceStepHandler

    unknown = [t for t in TRACKS if t not in TRACK_NAMES]
    if unknown:
        raise RuntimeError(f"ace-layer: tracks {unknown} are not in ACE-Step's TRACK_NAMES {TRACK_NAMES}")

    dit = AceStepHandler()
    t0 = time.time()
    status, ok = dit.initialize_service(project_root=str(ACE_ROOT), config_path=MODEL, device="cuda")
    if not ok:
        raise RuntimeError(f"ace-layer: ACE-Step {MODEL} failed to load: {status}")
    ctx.log(f"ace-layer: {MODEL} loaded in {time.time() - t0:.1f}s")
    return {"dit": dit}


def _lego(handle, p, src_wav: str, lyrics, seed: int, seconds: float):
    """One lego run of p's track over src_wav (lyrics None: instrumental): the part as (2, samples) float, its rate."""
    from acestep.inference import GenerationConfig, GenerationParams, generate_music

    # A sung part with words sings them (not instrumental); every other part stays "[Instrumental]".
    settings = {**ACE_SETTINGS, "lyrics": lyrics, "instrumental": False} if lyrics is not None else ACE_SETTINGS
    gp = GenerationParams(**settings, src_audio=src_wav, instruction=lego_instruction(p["track"]),
                          caption=p["caption"], bpm=p["bpm"], keyscale=p["key_scale"], seed=seed)
    config = GenerationConfig(batch_size=1, use_random_seed=False, seeds=[seed], audio_format="wav")
    result = generate_music(handle["dit"], None, gp, config, save_dir=None)
    if not result.success:
        raise RuntimeError(f"ace-layer: ACE-Step lego failed: {result.error}")
    if len(result.audios) != 1:
        raise RuntimeError(f"ace-layer: ACE-Step returned {len(result.audios)} audios, expected 1")
    out = result.audios[0]
    tensor, out_sr = out["tensor"], out["sample_rate"]
    if tensor is None:
        raise RuntimeError("ace-layer: ACE-Step returned no audio tensor")
    tensor = tensor.detach().float().cpu()
    if tensor.dim() != 2 or tensor.shape[0] != 2:
        raise RuntimeError(f"ace-layer: ACE-Step audio has shape {tuple(tensor.shape)}, expected (2, samples)")
    ace_seconds = tensor.shape[1] / out_sr
    if abs(ace_seconds - seconds) > 1.0:
        raise RuntimeError(f"ace-layer: ACE-Step returned {ace_seconds:.2f} s for {seconds:.2f} s of song")
    return tensor, out_sr


def _rap_sections(handle, p, src, sr, out_dir, job):
    """Rap per section (module docstring, `sections`): the full-length part, silent outside the sections."""
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio

    total = src.shape[0] / sr
    part = np.zeros((2, src.shape[0]), dtype=np.float32)
    for si, sec in enumerate(p["sections"]):
        step = job.step(f"rap_{sec['name']}", f"ACE raps {sec['name']}")
        ws, we = section_window(sec["start"], sec["end"], total, window_seconds(p["bpm"]))
        d = Path(out_dir) / "rap" / sec["name"]
        d.mkdir(parents=True, exist_ok=True)
        window = d / "window.wav"
        sf.write(str(window), src[int(round(ws * sr)):int(round(we * sr))], sr, subtype="FLOAT")
        span = (sec["start"] - ws, sec["end"] - ws)
        best, best_path, made, rounds = None, None, 0, []
        t = time.time()
        while made < MAX_RAP_TAKES and (best is None or best["recall"] < MIN_RAP_RECALL):
            n = min(p["takes"], MAX_RAP_TAKES - made)
            paths = []
            for k in range(made, made + n):
                job.check_cancelled()
                tensor, out_sr = _lego(handle, p, str(window), rap_lyrics(sec["lyrics"], we - ws, p["bpm"], sec["start"] - ws), p["seed"] + 1000 * si + k, we - ws)
                path = d / f"take{k + 1}.wav"
                # ACE floors its length to whole latent frames (up to 40 ms short): exactly the window's length.
                sf.write(str(path), fit_length(tensor.numpy(), int(round((we - ws) * out_sr))).T, out_sr, subtype="FLOAT")
                paths.append(str(path))
            job.check_cancelled()
            picked_path = d / f"best_of_round{len(rounds) + 1}.wav"
            picked = pick_rap_take(paths, sec["lyrics"], span[0], span[1], str(picked_path))
            scores = picked["takes"]
            rounds.append(scores)
            cand = {**scores[picked["best"]], "take": made + picked["best"] + 1}
            if best is None or rank(cand) > rank(best):
                best, best_path = cand, picked_path
            made += n
        if best["recall"] < MIN_RAP_RECALL:
            raise RuntimeError(f"ace-layer: ACE did not rap the words of {sec['name']} clearly in {made} takes (best: "
                               f"{best['recall']:.0%} of the words heard, \"{best['heard'][:200]}\")")
        vocal, vsr = sf.read(str(best_path), dtype="float32", always_2d=True)
        v = torch.from_numpy(np.ascontiguousarray(vocal.T))
        if vsr != sr:
            v = torchaudio.functional.resample(v, vsr, sr)
        a = int(round(sec["start"] * sr))
        b = min(int(round(sec["end"] * sr)), part.shape[1])
        if v.shape[1] < b - a - int(0.05 * sr):
            raise RuntimeError(f"ace-layer: the picked vocal of {sec['name']} is {v.shape[1] / sr:.2f} s, its section "
                               f"{(b - a) / sr:.2f} s")
        b = min(b, a + v.shape[1])
        part[:, a:b] = v.numpy()[:, :b - a]
        step.done(f"take {best['take']} of {made}: {best['recall']:.0%} of the words heard: \"{best['heard']}\"",
                  {"takes": made, "recall": best["recall"], "seconds": round(time.time() - t, 1),
                   **({"vocal_db": best["vocal_db"]} if best["vocal_db"] is not None else {}),
                   **({"backing_db": best["backing_db"]} if best["backing_db"] is not None else {})})
    return part


def generate(handle, params, out_dir, job):
    import numpy as np
    import soundfile as sf
    import torchaudio

    p = check_params(params)
    track = p["track"]
    name = track_label(track)

    # 1. Read the song.
    step = job.step("read", "Read the song")
    src, sr = sf.read(p["src_wav"], dtype="float32", always_2d=True)
    n = src.shape[0]
    seconds = n / sr
    if n == 0:
        raise ValueError(f"ace-layer: {p['src_wav']} has no audio")
    if not MIN_SECONDS <= seconds <= MAX_SECONDS:
        raise ValueError(f"ace-layer: the song is {seconds:.1f} s long; ACE-Step handles {MIN_SECONDS:.0f} s to "
                         f"{MAX_SECONDS:.0f} s in one go")
    if not np.any(src):
        raise ValueError(f"ace-layer: {p['src_wav']} is silent")
    step.done(f"{minutes(seconds)} at {sr} Hz, {src.shape[1]} channel(s)",
              {"seconds": round(seconds, 3), "sample_rate": sr})
    job.check_cancelled()

    if "sections" in p:
        # 2. Rap per section (each its own step), placed in a silent track of the song's length.
        part = _rap_sections(handle, p, src, sr, out_dir, job)
    else:
        # 2. ACE writes the part.
        step = job.step("lego", f"ACE writes the {name} part")
        t = time.time()
        tensor, out_sr = _lego(handle, p, p["src_wav"], p.get("lyrics"), p["seed"], seconds)
        took = time.time() - t
        step.done(f"{minutes(seconds)} of {name} in {took:.1f} s",
                  {"seconds": round(seconds, 3), "generation_seconds": round(took, 1)})
        job.check_cancelled()
        if out_sr != sr:
            tensor = torchaudio.functional.resample(tensor, out_sr, sr)
        part = fit_length(tensor.numpy(), n)

    # 3. Write the part: at the source's rate, exactly the source's length, stereo.
    step = job.step("write", "Write the part")
    if not np.any(part):
        raise RuntimeError("ace-layer: ACE-Step's part is silent")
    path = Path(out_dir) / "layer.wav"
    sf.write(str(path), part.T, sr, subtype="FLOAT")
    rms = level_db(part)
    peak = 20 * math.log10(float(np.max(np.abs(part))))
    step.done(f"{name} at {rms:.1f} dB RMS (peak {peak:.1f} dB)",
              {"rms_db": round(rms, 2), "peak_db": round(peak, 2), "seconds": round(n / sr, 3)}, ["layer.wav"])
    return {"file": str(path), "kind": "audio"}
