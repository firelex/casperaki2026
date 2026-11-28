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


def test_finish_can_speed_a_voice_up_more(tmp_path: Path):
    sr = 24000
    t = np.arange(int(3.3 * sr)) / sr
    raw = tmp_path / "raw.wav"
    sf.write(raw, (10 ** (-30 / 20)) * np.sin(2 * np.pi * 220 * t), sr)
    seconds = post.finish(raw, tmp_path / "out.wav", tempo=1.2)
    assert abs(seconds - 3.3 / (1.1 * 1.2)) < 0.05


def test_lines_pass_a_voice_tempo(tmp_path, monkeypatch):
    from pipeline import breeze, lines
    calls = []

    class FakeBreeze:
        def speak(self, text, instruction, seed, out, ref_audio=None, ref_text=None):
            out.parent.mkdir(parents=True, exist_ok=True)
            sf.write(out, 0.2 * np.sin(np.linspace(0, 2000, 24000)), 24000)
            return out

        def close(self):
            pass

    monkeypatch.setattr(breeze, "Breeze", FakeBreeze)
    monkeypatch.setattr(post, "finish", lambda raw, out, tempo=1.0: (calls.append(tempo), sf.write(out, np.zeros(4800), 48000), 0.1)[2])
    lines.run({"stage": "lines", "lines": [{"id": "ice-1", "text": "Right.", "instruction": "A man.", "seed": 7, "tempo": 1.15},
                                           {"id": "bob-1", "text": "Grand.", "instruction": "A man.", "seed": 21}]}, str(tmp_path), None)
    assert calls == [1.15, 1.0]
