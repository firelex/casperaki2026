"""Stage `speaking_voice`: a speaking voice for a singer. A voice copied from singing speaks as if singing (tried on
two singers, 2026-11-28), so instead: the description of the voice (written by the brain from the singing and the
uploader's words) is spoken with each seed, and the candidate whose voice is closest to the singer's reference
(SpeakerMatcher) is kept.

params: {"stage": "speaking_voice", "singer": <name, for messages>, "reference": <abs path to the singer's voice.wav>,
         "description": str, "test_line": str, "seeds": [int, ...], "match": bool}
        match false (a voice the user described): exactly one seed, spoken and kept without matching (scores {}).
        The reference is checked for at least 1 s of voice before any model loads.
files:  candidate-<seed>.wav (finished, post.finish) and speaking_voice.json =
        {"best_seed": int, "scores": {"<seed>": float}, "sample": "candidate-<best>.wav"}
"""
from __future__ import annotations

import json
from pathlib import Path

from . import post


def check(params) -> tuple[str, Path, str, str, list[int], bool]:
    singer = params.get("singer")
    if not isinstance(singer, str) or not singer.strip():
        raise ValueError("speech: no singer name")
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
    match = params.get("match")
    if not isinstance(match, bool):
        raise ValueError("speech: match must be true or false")
    if not match and len(seeds) != 1:
        raise ValueError("speech: a voice that is not matched is spoken with one seed")
    return singer.strip(), Path(ref), description.strip(), line.strip(), seeds, match


def run(params, out_dir, job):
    singer, ref, description, line, seeds, match = check(params)
    out = Path(out_dir)
    from . import breeze, match as matching

    if match:
        voice = matching.voiced_seconds(ref)
        if voice < 1:
            raise ValueError(f"speech: {singer}'s voice reference has {voice:.1f} s of voice; matching needs at least 1 s of voice")
    Breeze, SpeakerMatcher = breeze.Breeze, matching.SpeakerMatcher

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
    if not match:
        result = {"best_seed": seeds[0], "scores": {}, "sample": f"candidate-{seeds[0]}.wav"}
        (out / "speaking_voice.json").write_text(json.dumps(result))
        return {"file": str(out / "speaking_voice.json"), "kind": "json"}
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
