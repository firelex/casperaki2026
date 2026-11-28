"""Stage `lines`: speak a list of lines, each in a described voice, each finished (post.finish).

params: {"stage": "lines", "lines": [{"id": "ice-1", "text": ..., "instruction": <voice description>, "seed": 7,
          "reference_text": <optional>, "direction": <optional, only with reference_text>, "tempo": <optional, 0.7-1.6>}]}
files:  <id>.wav for each line, and lines.json = {"lines": [{"id", "file", "seconds"}]}

A line with reference_text is copied from its voice's reference: the voice (instruction and seed) saying reference_text,
made once per voice in the job (raw, unfinished). Breeze copies a voice from a reference far more faithfully than it
keeps one from a description (similarity to the reference 0.95-0.98 against 0.81-0.90, accent included), and the
optional direction (the line's delivery, e.g. "dry, withering") steers the copy without changing the person.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from . import post

ID = re.compile(r"^[a-z0-9-]+$")


def check(lines) -> list[dict]:
    if not isinstance(lines, list) or not lines:
        raise ValueError("speech: no lines to speak")
    seen = set()
    for i, ln in enumerate(lines):
        where = f"speech: line {i + 1}"
        if not isinstance(ln, dict):
            raise ValueError(f"{where} is not an object")
        if not isinstance(ln.get("id"), str) or not ID.match(ln["id"]):
            raise ValueError(f"{where}: its id must be lower-case letters, digits and hyphens")
        if ln["id"] in seen:
            raise ValueError(f"{where}: the id {ln['id']!r} is used twice")
        seen.add(ln["id"])
        for key in ("text", "instruction"):
            if not isinstance(ln.get(key), str) or not ln[key].strip():
                raise ValueError(f"{where} ({ln['id']}): no {key}")
        if not isinstance(ln.get("seed"), int) or isinstance(ln.get("seed"), bool):
            raise ValueError(f"{where} ({ln['id']}): the seed must be a whole number")
        if "reference_text" in ln and (not isinstance(ln["reference_text"], str) or not ln["reference_text"].strip()):
            raise ValueError(f"{where} ({ln['id']}): the reference_text must be the words the reference says")
        if "tempo" in ln and (not isinstance(ln["tempo"], (int, float)) or isinstance(ln["tempo"], bool) or not 0.7 <= ln["tempo"] <= 1.6):
            raise ValueError(f"{where} ({ln['id']}): the tempo must be a number from 0.7 to 1.6")
        if "direction" in ln:
            if "reference_text" not in ln:
                raise ValueError(f"{where} ({ln['id']}): a direction needs a reference_text (it steers a copied voice)")
            if not isinstance(ln["direction"], str) or not ln["direction"].strip():
                raise ValueError(f"{where} ({ln['id']}): the direction must be words")
    return lines


def run(params, out_dir, job):
    lines = check(params.get("lines"))
    out = Path(out_dir)
    from .breeze import Breeze

    breeze = Breeze()
    done = []
    try:
        references: dict[tuple[str, int, str], Path] = {}
        for ln in lines:
            step = job.step(ln["id"], ln["text"][:60]) if job else None
            if "reference_text" in ln:
                key = (ln["instruction"].strip(), ln["seed"], ln["reference_text"].strip())
                if key not in references:
                    references[key] = breeze.speak(key[2], key[0], key[1], out / "references" / f"reference-{len(references) + 1}.wav")
                raw = breeze.speak(ln["text"], ln.get("direction"), ln["seed"], out / "raw" / f"{ln['id']}.wav", ref_audio=references[key], ref_text=key[2])
            else:
                raw = breeze.speak(ln["text"], ln["instruction"], ln["seed"], out / "raw" / f"{ln['id']}.wav")
            seconds = post.finish(raw, out / f"{ln['id']}.wav", tempo=float(ln.get("tempo", 1.0)))
            done.append({"id": ln["id"], "file": f"{ln['id']}.wav", "seconds": round(seconds, 3)})
            if step:
                step.done(f"{seconds:.1f} s", {"seconds": seconds}, [f"{ln['id']}.wav"])
    finally:
        breeze.close()
    (out / "lines.json").write_text(json.dumps({"lines": done}))
    return {"file": str(out / "lines.json"), "kind": "json"}
