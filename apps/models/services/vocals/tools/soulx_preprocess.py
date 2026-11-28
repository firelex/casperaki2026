"""SoulX-Singer-Preprocess's steps for the vocals service's add-singer stage (pipeline/add_singer.py).

Runs in SoulX-Singer-Preprocess's own venv (pipeline.paths.SOULX_PREPROCESS_PYTHON) with the working directory = the
SoulX-Singer clone (pipeline.paths.SOULX_REPO), whose model paths are relative to it; a process of its own, so its
models are the only ones on the graphics card while it runs. Three commands:

  separate <in.wav> <out.wav>
      The lead vocal of a full song: the karaoke Mel-Band RoFormer separation (SoulX-Singer-Preprocess's,
      preprocess/tools/vocal_separation). Writes the lead vocal (mono, 44.1 kHz); the add-singer stage then takes its
      reverb out with anvuew's room model (pipeline/dereverb.py; SoulX's own de-reverb model left the owner's test
      recordings almost unchanged, 2026-11-28).
      Prints {"sample_rate", "seconds"}.

  words <reference.wav> <out.json>
      The words sung in the voice reference (NVIDIA Parakeet-TDT 0.6B v2, SoulX-Singer-Preprocess's English lyric
      recogniser) with their timing, the rests placed by the pitch curve the stage saved next to the reference as
      <name>_f0.npy (RMVPE). On the CPU: on this graphics card (RTX PRO 6000 Blackwell, WSL) NeMo's encoder fails
      with "CUDA driver error: unknown error" and leaves the process unable to use the card at all (so the note
      step below runs in a process of its own); 10 s of audio takes seconds on the CPU.
      Writes {"words": [...], "durations": [...]} ("<SP>" for a rest).

  notes <reference.wav> <words.json> <out.json>
      The notes sung on those words (ROSVOT, SoulX-Singer-Preprocess's note transcriber) and their phonemes (g2p_en).
      Writes {"text", "durations", "pitches", "types", "phonemes"}: one item per note or rest, as SoulX's prompt
      metadata lists them (pipeline/voice_meta.py words_meta builds the metadata from it).

English only. A melody sung as "la la la" is transcribed in the vocals service itself (pipeline/add_singer.py).
"""
import json
import os
import sys
from pathlib import Path

REPO = Path.cwd()
if not (REPO / "preprocess" / "pipeline.py").is_file():
    raise SystemExit(f"soulx_preprocess: run me with the working directory = the SoulX-Singer clone, not {REPO}")
sys.path.insert(0, str(REPO))

MODELS = "pretrained_models/SoulX-Singer-Preprocess"
SEP_MODEL = f"{MODELS}/mel-band-roformer-karaoke/mel_band_roformer_karaoke_becruily.ckpt"
SEP_CONFIG = f"{MODELS}/mel-band-roformer-karaoke/config_karaoke_becruily.yaml"
DER_MODEL = f"{MODELS}/dereverb_mel_band_roformer/dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt"
DER_CONFIG = f"{MODELS}/dereverb_mel_band_roformer/dereverb_mel_band_roformer_anvuew.yaml"
PARAKEET = f"{MODELS}/parakeet-tdt-0.6b-v2/parakeet-tdt-0.6b-v2.nemo"
ROSVOT = f"{MODELS}/rosvot/rosvot/model.pt"
RWBD = f"{MODELS}/rosvot/rwbd/model.pt"
LANGUAGE = "English"


def separate(src: str, dest: str) -> None:
    import numpy as np
    import soundfile as sf
    from preprocess.tools.vocal_separation.model import VocalSeparator

    sep = VocalSeparator(sep_model_path=SEP_MODEL, sep_config_path=SEP_CONFIG, der_model_path=DER_MODEL,
                         der_config_path=DER_CONFIG, use_der=False, device="cuda", verbose=False)
    out = sep.process(src, verbose=False)
    y = np.asarray(out.vocals, dtype=np.float32)
    y = y.mean(axis=0) if y.ndim == 2 else y
    sf.write(dest, y, out.sample_rate, subtype="FLOAT")
    print(json.dumps({"sample_rate": int(out.sample_rate), "seconds": round(len(y) / out.sample_rate, 3)}), flush=True)


def words(ref: str, dest: str) -> None:
    from omegaconf import open_dict
    from preprocess.tools.lyric_transcription import _ASREnModel

    if not Path(os.path.splitext(ref)[0] + "_f0.npy").is_file():
        raise SystemExit(f"soulx_preprocess words: the pitch curve {os.path.splitext(ref)[0]}_f0.npy is missing")
    asr = _ASREnModel(model_path=PARAKEET, device="cpu")
    with open_dict(asr.model.cfg):
        asr.model.cfg.decoding.greedy.use_cuda_graph_decoder = False
    asr.model.change_decoding_strategy(asr.model.cfg.decoding)
    ws, durs = asr.process(ref)
    Path(dest).write_text(json.dumps({"words": list(ws), "durations": [float(d) for d in durs]}, ensure_ascii=False))
    print(json.dumps({"words": " ".join(w for w in ws if w != "<SP>")}), flush=True)


def notes(ref: str, words_json: str, dest: str) -> None:
    import soundfile as sf
    from preprocess.tools.g2p import g2p_transform
    from preprocess.tools.note_transcription.model import NoteTranscriber

    w = json.loads(Path(words_json).read_text())
    info = sf.info(ref)
    ms = int(round(info.frames / info.samplerate * 1000))
    item = {"item_name": Path(ref).stem, "wav_fn": ref, "origin_wav_fn": ref, "start_time_ms": 0, "end_time_ms": ms,
            "duration": ms, "words": w["words"], "word_durs": w["durations"], "language": LANGUAGE}
    nt = NoteTranscriber(rosvot_model_path=ROSVOT, rwbd_model_path=RWBD, device="cuda", verbose=False)
    out = nt.process(item, segment_info=item, verbose=False)
    text = list(out["note_text"])
    res = {"text": text, "durations": [float(d) for d in out["note_dur"]], "pitches": [int(p) for p in out["note_pitch"]],
           "types": [int(t) for t in out["note_type"]], "phonemes": list(g2p_transform(text, LANGUAGE))}
    Path(dest).write_text(json.dumps(res, ensure_ascii=False))
    print(json.dumps({"notes": sum(1 for t in res["types"] if t != 1)}), flush=True)


if __name__ == "__main__":
    commands = {"separate": (separate, 2), "words": (words, 2), "notes": (notes, 3)}
    if len(sys.argv) < 2 or sys.argv[1] not in commands or len(sys.argv) != 2 + commands[sys.argv[1]][1]:
        raise SystemExit(__doc__)
    commands[sys.argv[1]][0](*sys.argv[2:])
