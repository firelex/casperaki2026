"""Every spoken line is finished the same way (the owner, 2026-11-28: "play them a bit faster, though, and also
compress them"): 1.1x faster with its pitch kept, compressed, levelled to -16 LUFS, 48 kHz mono WAV."""
from __future__ import annotations

import subprocess
from pathlib import Path

import soundfile as sf

CHAIN = "atempo=1.1,acompressor=threshold=-20dB:ratio=4:attack=5:release=80:makeup=4,loudnorm=I=-16:TP=-1.5:LRA=7"


def finish(raw: Path, out: Path) -> float:
    """Finishes `raw` into `out`; returns its length in seconds."""
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(raw), "-af", CHAIN, "-ar", "48000", "-ac", "1", str(out)],
                   check=True)
    return sf.info(out).duration
