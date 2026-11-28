# svc-speech

Model service (port 16516, harness adapter `speech`) that speaks lines in voices made from written descriptions
(Breeze TTS 2) and gives singers a speaking voice. `generate` dispatches on `params["stage"]`:

- `lines` (`pipeline/lines.py`): `{"lines": [{"id", "text", "instruction", "seed"}]}` → `<id>.wav` per line and
  `lines.json`. The instruction is the voice's description; the same description and seed give the same voice.
- `speaking_voice` (`pipeline/speaking_voice.py`): a singer's speaking voice (see the file).

Every line is finished by `pipeline/post.py`: 1.1x faster (pitch kept), compressed, -16 LUFS, 48 kHz mono.

Breeze loads per job (eager, about 8 GB on the GPU) and is released after it. Its code, weights and venv are not in
this repo: `~/breeze-tts-2` on datigator (`code/` at its pinned upstream commit, `weights/`, `.venv/` Python 3.12, all
made by that folder's `setup.sh`). This service's `.venv` is a link to Breeze's (the adapter's setup makes it). The
speaker model for matching: `tools/fetch_wavlm.py`.

Licence: Breeze's model and everything it generates are for research and non-commercial use only.

Tests: `~/breeze-tts-2/.venv/bin/python -m pytest tests -q`.
