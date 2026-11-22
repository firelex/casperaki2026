"""Library sounds for the sampler: which recordings, where each note slot sits, what pitch it really sounds.

The sample library holds one long recording per sound: a chromatic grid of held notes (every minor third,
c2 upwards), laid out by the legacy slice tables in packages/engine-adapter/data/vst-slice-timings/.
A recording's labelled pitch can be off by whole octaves; packages/engine-adapter/data/octave-adjustment-per-row.json
measured that per sound (`adjustment` = octaves the engine transposes UP to make it sound right, so the
recording itself sounds `12 * adjustment` semitones BELOW its label). We measure every slot again with pYIN
when building the cache (sounding pitch and fine tuning in cents) and refuse a sound whose measurement does
not agree with the table.

`build_cache` decodes each used recording once (ffmpeg, 22,050 Hz mono) and stores every long-note slot,
trimmed to its real attack, as float32 in one .npz per sound plus a JSON catalogue.
"""
from __future__ import annotations

import json
import math
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SR = 22050
REPO = Path(__file__).resolve().parents[4]
LIBRARY_ROOT = Path("/mnt/d/Scissero Dropbox/Mathias Strasser/datigator-instruments/instruments")
OCTAVE_TABLE = REPO / "packages/engine-adapter/data/octave-adjustment-per-row.json"
SLICE_DIR = REPO / "packages/engine-adapter/data/vst-slice-timings"
VOCAL_RECORDING = "vocals/vocalsLaSinger/vocals - vocalsLaSinger - brightPop - omnisphere - BackingsAh.mp3"

FAMILY_LAYOUT = {
    "basses": "bassNotes",
    "keys": "pianoNotes",
    "synths": "padAndSynthNotes",
    "leadSynths": "padAndSynthNotes",
    "popStrings": "padAndSynthNotes",
    "orchestral": "padAndSynthNotes",
    "popBrass": "padAndSynthNotes",
    "acousticGuitars": "guitarNotes",
    "electricGuitars": "guitarNotes",
    "vocals": "laNaSingerNotes",
}
# Sounds that are not a playable melody line: one-shot hits, and wobble basses whose built-in LFO pulses at
# its own tempo (it would teach a beat that has nothing to do with the clip).
EXCLUDED_LOW_LEVELS = {"orchestralHit", "bassesSynthWobble"}

# Sounds kept out of training entirely, used only for the test-unseen split (whole low-level groups).
HELD_OUT_LOW_LEVELS = {
    "keysElectronicPiano",
    "leadSynthsAnalog",
    "popBrassReedsSoloLegato",
    "popBrassReedsSoloStaccato",
    "orchestralViolinSolo",
    "orchestralViolinLegato",
    "acousticGuitarsNylonMono",
    "acousticGuitarsNylonStereo",
    "bassesAcoustic",
}

# Broad instrument groups for picking a lead and for the score breakdown.
GROUP_OF_FAMILY = {
    "basses": "bass",
    "keys": "keys",
    "synths": "synth",
    "leadSynths": "synth",
    "popStrings": "strings_brass",
    "orchestral": "strings_brass",
    "popBrass": "strings_brass",
    "acousticGuitars": "guitar",
    "electricGuitars": "guitar",
    "vocals": "vocal_sample",
}

NOTE_INDEX = {"c": 0, "c#": 1, "d": 2, "d#": 3, "e": 4, "f": 5, "f#": 6, "g": 7, "g#": 8, "a": 9, "a#": 10, "b": 11}


def note_to_midi(name: str) -> int:
    """'c3' -> 48 (the library's convention: c3 is the C below middle C)."""
    pitch, octave = name[:-1], int(name[-1])
    if pitch not in NOTE_INDEX:
        raise ValueError(f"unknown note name {name!r}")
    return 12 * (octave + 1) + NOTE_INDEX[pitch]


def parse_slice_time(s: str) -> float:
    """'01.02.40' -> 62.4 s, '00.06' -> 6.0 s (minutes.seconds[.hundredths])."""
    parts = s.split(".")
    if len(parts) == 2:
        return int(parts[0]) * 60 + int(parts[1])
    if len(parts) == 3:
        return int(parts[0]) * 60 + int(parts[1]) + int(parts[2]) / 100
    raise ValueError(f"cannot parse slice time {s!r}")


def long_note_slots(layout: str) -> list[tuple[int, float, float]]:
    rows = json.loads((SLICE_DIR / f"{layout}.json").read_text())
    return [(note_to_midi(r["note"]), parse_slice_time(r["start"]), parse_slice_time(r["end"])) for r in rows if r["type"] == "longNote"]


@dataclass(frozen=True)
class SoundRow:
    sound_id: str
    family: str
    low_level: str
    preset: str
    path: str
    layout: str
    table_offset: int | None  # semitones the recording sounds relative to its label, from the octave table (None: not in it)


def candidate_rows() -> list[SoundRow]:
    table = json.loads(OCTAVE_TABLE.read_text())["byCatalogId"]
    rows = []
    for cid, r in table.items():
        if r["lowLevel"] in EXCLUDED_LOW_LEVELS:
            continue
        if not r["adjustmentReliable"] or "detectedHz" not in r or "matchedPath" not in r:
            continue
        rows.append(SoundRow(cid, r["family"], r["lowLevel"], r["preset"], r["matchedPath"], FAMILY_LAYOUT[r["family"]], -12 * int(r["adjustment"])))
    rows.append(SoundRow("vocal-la-backings-ah", "vocals", "vocalsLaSinger", "BackingsAh", VOCAL_RECORDING, "laNaSingerNotes", None))
    return rows


def decode(path: Path) -> np.ndarray:
    out = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(out, dtype=np.float32).copy()


def _envelope(x: np.ndarray, win: int = 110) -> np.ndarray:
    return np.sqrt(np.convolve(x.astype(np.float64) ** 2, np.ones(win) / win, mode="same"))


def measure_sound(row: SoundRow) -> dict:
    """Decode one recording, cut its long-note slots at their real attacks, measure their pitch.

    Returns {"row":..., "slots":[...], "audio": {slot_index: array}} or {"row":..., "rejected": reason}.
    """
    import librosa

    audio = decode(LIBRARY_ROOT / row.path)
    slots_out, arrays = [], {}
    offsets = []
    for i, (label_midi, start, end) in enumerate(long_note_slots(row.layout)):
        a, b = int(start * SR), min(int(end * SR), len(audio))
        seg = audio[a:b]
        if len(seg) < SR:
            continue
        env = _envelope(seg)
        peak = env[: int(1.5 * SR)].max()
        if peak < 1e-4:
            continue
        above = np.nonzero(env > 0.1 * peak)[0]
        on10 = int(above[0])
        on90 = int(np.nonzero(env > 0.9 * peak)[0][0])
        attack_ms = (on90 - on10) / SR * 1000
        onset = max(0, on10 - int(0.005 * SR))
        body = seg[onset:]
        # pitch over the steady part (0.3 s .. 1.3 s after the attack)
        probe = body[int(0.3 * SR): int(1.3 * SR)]
        f0, voiced, _ = librosa.pyin(probe, fmin=30, fmax=2000, sr=SR, frame_length=2048)
        f0 = f0[voiced & np.isfinite(f0)]
        if len(f0) < 10:
            continue
        sounding = 69 + 12 * math.log2(float(np.median(f0)) / 440.0)
        offsets.append(sounding - label_midi)
        # the whole slot's pitch contour (10 ms hop), as cents relative to the slot's median pitch; the renderer
        # adds it to a sampled note's stored pitch curve, so the recording's own vibrato and bends are labelled
        f0_all, v_all, _ = librosa.pyin(body, fmin=30, fmax=2000, sr=SR, frame_length=2048, hop_length=220)
        contour = np.where(v_all & np.isfinite(f0_all), 1200 * np.log2(np.where(np.isfinite(f0_all), f0_all, 1.0) / 440.0) + 6900 - 100 * sounding, np.nan)
        contour = np.where(np.abs(contour) > 150, np.nan, contour)  # octave jumps and wrong notes of the tracker
        rms = float(np.sqrt(np.mean(body[: int(0.5 * SR)] ** 2)))
        slots_out.append({"label_midi": label_midi, "sounding_float": sounding, "attack_ms": attack_ms, "rms": rms, "length_s": len(body) / SR})
        arrays[f"slot{len(slots_out) - 1}"] = body.astype(np.float32)
        arrays[f"slot{len(slots_out) - 1}_cents"] = contour.astype(np.float32)
    if len(slots_out) < 4:
        return {"row": row.__dict__, "rejected": f"only {len(slots_out)} measurable slots"}
    whole = [round(o / 12) * 12 for o in offsets]
    common = max(set(whole), key=whole.count)
    agree = whole.count(common) / len(whole)
    if agree < 0.7:
        return {"row": row.__dict__, "rejected": f"slot octaves disagree ({whole})"}
    if row.table_offset is not None and common != row.table_offset:
        return {"row": row.__dict__, "rejected": f"pYIN says the recording sounds {common:+d} semitones from its labels, the octave table says {row.table_offset:+d}"}
    kept_slots, kept_arrays = [], {}
    for idx, (s, o, w) in enumerate(zip(slots_out, offsets, whole)):
        if w != common:
            continue  # this slot's pitch reading is an octave error or a wrong note: leave the slot out
        s = dict(s)
        s["sounding_midi"] = s["label_midi"] + common
        s["tuning_cents"] = (o - common) * 100
        kept_arrays[f"slot{len(kept_slots)}"] = arrays[f"slot{idx}"]
        kept_arrays[f"slot{len(kept_slots)}_cents"] = arrays[f"slot{idx}_cents"]
        kept_slots.append(s)
    median_attack = float(np.median([s["attack_ms"] for s in kept_slots]))
    return {"row": row.__dict__, "offset": common, "slot_agreement": agree, "median_attack_ms": median_attack, "slots": kept_slots, "audio": kept_arrays}



def build_cache(cache_dir: Path, workers: int = 24) -> dict:
    """Measure and cache every candidate sound; writes cache_dir/catalogue.json and one .npz per sound."""
    from concurrent.futures import ProcessPoolExecutor

    cache_dir.mkdir(parents=True, exist_ok=True)
    rows = candidate_rows()
    catalogue = {"sample_rate": SR, "sounds": [], "rejected": []}
    with ProcessPoolExecutor(workers) as pool:
        for res in pool.map(measure_sound, rows):
            if "rejected" in res:
                catalogue["rejected"].append({"sound_id": res["row"]["sound_id"], "path": res["row"]["path"], "reason": res["rejected"]})
                continue
            row = res.pop("row")
            audio = res.pop("audio")
            np.savez(cache_dir / f"{row['sound_id']}.npz", **audio)
            catalogue["sounds"].append({**row, **res, "group": GROUP_OF_FAMILY[row["family"]], "held_out": row["low_level"] in HELD_OUT_LOW_LEVELS})
    (cache_dir / "catalogue.json").write_text(json.dumps(catalogue, indent=1))
    return catalogue


class SoundBank:
    """Read-only access to the cached slots (memory-mapped, so parallel workers share the page cache)."""

    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir
        cat = json.loads((cache_dir / "catalogue.json").read_text())
        self.sounds = {s["sound_id"]: s for s in cat["sounds"]}
        self._audio: dict[str, dict] = {}

    def slots(self, sound_id: str) -> list[dict]:
        return self.sounds[sound_id]["slots"]

    def slot_audio(self, sound_id: str, i: int) -> np.ndarray:
        if sound_id not in self._audio:
            self._audio[sound_id] = np.load(self.cache_dir / f"{sound_id}.npz", mmap_mode="r")
        return self._audio[sound_id][f"slot{i}"]

    def slot_contour(self, sound_id: str, i: int) -> np.ndarray:
        """Pitch of the slot relative to its median, cents, 10 ms hop (NaN where the tracker found no pitch)."""
        self.slot_audio(sound_id, i)
        return self._audio[sound_id][f"slot{i}_cents"]

    def sounding_range(self, sound_id: str) -> tuple[int, int]:
        m = [s["sounding_midi"] for s in self.slots(sound_id)]
        return min(m) - 1, max(m) + 1
