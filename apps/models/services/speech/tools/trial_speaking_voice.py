"""Trial of the speaking_voice stage outside the service (the owner's listening test, plan task 3).
Usage: ~/breeze-tts-2/.venv/bin/python tools/trial_speaking_voice.py <reference.wav> <name> "<description>" <out dir>
Writes the candidates and speaking_voice.json into <out dir> and prints the scores."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pipeline import paths  # noqa: E402

sys.path.append(str(paths.BREEZE_CODE))
from pipeline import speaking_voice  # noqa: E402

SEEDS = [7, 11, 21, 33, 42, 57, 64, 99]

ref, name, description, out = sys.argv[1:5]
Path(out).mkdir(parents=True, exist_ok=True)
line = f"Hi, I'm {name}. Honestly, I'm a bit nervous, but I'm really excited to be here."
speaking_voice.run({"stage": "speaking_voice", "singer": name, "match": True, "reference": str(Path(ref).resolve()), "description": description,
                    "test_line": line, "seeds": SEEDS}, out, None)
print(json.dumps(json.loads((Path(out) / "speaking_voice.json").read_text()), indent=1))
