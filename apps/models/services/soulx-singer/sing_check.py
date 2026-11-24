"""Smoke check of the running singing service (svc-soulx): sings one 4-bar line with every voice.

  python3 sing_check.py [http://127.0.0.1:16512]

Checks per voice: 24 kHz audio, length within 0.25 s of the line, not silent (RMS above -40 dBFS). Then an unknown
phone must answer 422 naming it. Writes the takes to /tmp-free scratch next to this file (sing_check_out/) for
listening. Exits non-zero on the first failure.
"""
import base64
import io
import json
import math
import struct
import sys
import urllib.error
import urllib.request
import wave
from pathlib import Path

URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:16512").rstrip("/")
OUT = Path(__file__).resolve().parent / "sing_check_out"

# "Walking through the golden day" at 100 bpm (0.6 s a beat), C4..E4, then a rest.
WORDS = [("en_W-AO1", 60, 0.6), ("en_K-IH0-NG", 60, 0.3), ("en_TH-R-UW1", 62, 0.3), ("en_DH-AH0", 64, 0.6),
         ("en_G-OW1-L", 64, 0.6), ("en_D-AH0-N", 62, 0.6), ("en_D-EY1", 60, 1.8)]
PHRASE = {
    "phoneme": ["<SP>"] + [w for w, _, _ in WORDS] + ["<SP>"],
    "duration": [0.3] + [d for _, _, d in WORDS] + [0.6],
    "notePitch": [0] + [p for _, p, _ in WORDS] + [0],
    "noteType": [1] + [2] * len(WORDS) + [1],
}
LENGTH = sum(PHRASE["duration"])


def post(path: str, body: dict) -> tuple[int, dict]:
    req = urllib.request.Request(URL + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def main() -> None:
    OUT.mkdir(exist_ok=True)
    code, v = post("/voices", {})
    assert code == 200, (code, v)
    for voice in v["voices"]:
        code, r = post("/sing", {"voice": voice["id"], "steps": 32, "shift": 0, "phrases": [PHRASE]})
        assert code == 200, (voice["id"], code, r)
        raw = base64.b64decode(r["phrases"][0]["wav"])
        (OUT / f"{voice['id']}.wav").write_bytes(raw)
        with wave.open(io.BytesIO(raw)) as w:
            sr, n = w.getframerate(), w.getnframes()
            frames = struct.unpack(f"<{n}h", w.readframes(n))
        secs = n / sr
        rms = math.sqrt(sum(x * x for x in frames) / n) / 32768
        db = 20 * math.log10(max(rms, 1e-9))
        print(f"{voice['id']:14s} {sr} Hz {secs:.2f} s (line {LENGTH:.2f} s) rms {db:.1f} dBFS  {r['tookMs']} ms")
        assert sr == 24000 and abs(secs - LENGTH) <= 0.25 and db > -40, voice["id"]
    bad = dict(PHRASE, phoneme=["<SP>", "en_QQ1"] + PHRASE["phoneme"][2:])
    code, r = post("/sing", {"voice": v["voices"][0]["id"], "steps": 32, "shift": 0, "phrases": [bad]})
    assert code == 422 and "en_QQ1" in r["error"], (code, r)
    print("unknown phone -> 422:", r["error"])
    print("ok")


if __name__ == "__main__":
    main()
