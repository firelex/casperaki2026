"""Stage `speaking_voice`: a speaking voice for a singer. A voice copied from singing speaks as if singing (tried on
two singers, 2026-11-28), so instead: the description of the voice (written by the brain from the singing and the
uploader's words) is spoken with each seed, and the candidate whose voice is closest to the singer's reference
(SpeakerMatcher) is kept.

params: {"stage": "speaking_voice", "reference": <abs path to the singer's voice.wav>, "description": str,
         "test_line": str, "seeds": [int, ...]}
files:  candidate-<seed>.wav (finished, post.finish) and speaking_voice.json =
        {"best_seed": int, "scores": {"<seed>": float}, "sample": "candidate-<best>.wav"}
"""
from __future__ import annotations

import json
from pathlib import Path

from . import post


def check(params) -> tuple[Path, str, str, list[int]]:
    ref = params.get("reference")
    if not isinstance(ref, str) or not Path(ref).is_absolute():
        raise ValueError("speech: the reference must be an absolute path")
    if not Path(ref).is_file():
        raise ValueError(f"speech: there is no reference at {ref}")
    description, line = params.get("description"), params.get("test_line")
    if not isinstance(description, str) or not description.strip():
        raise ValueError("speech: no description of the voice")
    if not isinstance(line, str) or not line.strip():
        raise ValueError("speech: no test line")
    seeds = params.get("seeds")
    if (not isinstance(seeds, list) or not seeds or len(set(map(repr, seeds))) != len(seeds)
            or not all(isinstance(s, int) and not isinstance(s, bool) for s in seeds)):
        raise ValueError("speech: the seeds must be a list of different whole numbers")
    return Path(ref), description.strip(), line.strip(), seeds


def run(params, out_dir, job):
    ref, description, line, seeds = check(params)
    out = Path(out_dir)
    from .breeze import Breeze
    from .match import SpeakerMatcher

    breeze = Breeze()
    try:
        for seed in seeds:
            step = job.step(f"speak-{seed}", f"candidate voice {seed}") if job else None
            raw = breeze.speak(line, description, seed, out / "raw" / f"candidate-{seed}.wav")
            seconds = post.finish(raw, out / f"candidate-{seed}.wav")
            if step:
                step.done(f"{seconds:.1f} s", {"seconds": seconds}, [f"candidate-{seed}.wav"])
    finally:
        breeze.close()
    step = job.step("match", "closest to the singing voice") if job else None
    matcher = SpeakerMatcher()
    try:
        target = matcher.embed(ref)
        scores = {str(s): round(matcher.similarity(target, matcher.embed(out / f"candidate-{s}.wav")), 4) for s in seeds}
    finally:
        matcher.close()
    best = max(seeds, key=lambda s: scores[str(s)])
    result = {"best_seed": best, "scores": scores, "sample": f"candidate-{best}.wav"}
    (out / "speaking_voice.json").write_text(json.dumps(result))
    if step:
        step.done(f"seed {best} ({scores[str(best)]:.2f})", {"similarity": scores[str(best)]}, [f"candidate-{best}.wav"])
    return {"file": str(out / "speaking_voice.json"), "kind": "json"}
