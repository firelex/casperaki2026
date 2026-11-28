"""post.finish: every spoken line sped up 1.1x (pitch kept) and compressed and levelled to -16 LUFS, 48 kHz mono."""
import re
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from pipeline import post


def loudness(path: Path) -> float:
    out = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128", "-f", "null", "-"],
                         capture_output=True, text=True, check=True).stderr
    return float(re.findall(r"I:\s+(-?[\d.]+) LUFS", out)[-1])


def test_finish_speeds_up_and_levels(tmp_path: Path):
    sr = 24000
    t = np.arange(int(3.3 * sr)) / sr
    raw = tmp_path / "raw.wav"
    sf.write(raw, (10 ** (-30 / 20)) * np.sin(2 * np.pi * 220 * t), sr)
    out = tmp_path / "out.wav"
    seconds = post.finish(raw, out)
    info = sf.info(out)
    assert abs(seconds - 3.0) < 0.05
    assert abs(info.duration - 3.0) < 0.05
    assert info.samplerate == 48000 and info.channels == 1
    assert abs(loudness(out) + 16) < 1
