"""Breeze TTS 2 in this process: a voice from a written description (the instruction), the same seed giving the same
voice. Driven exactly as the upstream code/infer.py does (its defaults: eager attention, the same generation limits), so
a voice chosen on the Breeze page or with infer.py sounds the same here."""
from __future__ import annotations

import gc
from pathlib import Path

import soundfile as sf

from . import paths


class Breeze:
    """Loads the model on the GPU (about 8 GB); speak() as often as needed, then close()."""

    def __init__(self) -> None:
        import infer  # code/infer.py: its constants and imports are the upstream's own

        self._infer = infer
        self.tokenizer, self.model, self.audio_tokenizer = infer.load_runtime(
            paths.BREEZE_WEIGHTS, device=infer.resolve_device(), attn_implementation="eager")
        infer.update_generation_config_for_breeze(self.model)
        config = infer.FastStreamingConfig(
            max_new_tokens=infer.MAX_NEW_TOKENS, max_seq_len=infer.MAX_SEQ_LEN, fast_all=None,
            fast_text_encoder=False, fast_backbone_prefill=False, fast_backbone_decode=False,
            fast_depth_decoder=False, fast_codec=False, repetition_penalty=infer.REPETITION_PENALTY)
        self.runtime = infer.FastBreezeStreamingRuntime(self.model, self.audio_tokenizer, config, tokenizer=self.tokenizer)
        if self.runtime.fast_enabled:
            raise RuntimeError("speech: Breeze started on its fast path; this service runs it eagerly like infer.py")

    def speak(self, text: str, instruction: str, seed: int, out: Path) -> Path:
        infer = self._infer
        request = {"id": "line", "text": text, "speaker": "S0", "instruction": instruction.strip()}
        infer.set_all_seeds(seed)
        inputs = infer.prepare_inputs(self.tokenizer, self.audio_tokenizer, self.model, [request],
                                      infer.get_template(infer.select_template_name(request)),
                                      guidance_scale=infer.DEFAULT_CFG_SCALE, guidance_scale_ref=None, guidance_scale_ins=None)
        out.parent.mkdir(parents=True, exist_ok=True)
        with sf.SoundFile(out, mode="w", samplerate=self.runtime.sample_rate, channels=1, subtype="PCM_16") as f:
            for chunk in self.runtime.iter_audio_chunks(inputs, request_id="line", seed=seed):
                f.write(chunk.audio)
        if sf.info(out).frames == 0:
            raise RuntimeError(f"speech: Breeze made no sound for {text[:60]!r}")
        return out

    def close(self) -> None:
        import torch

        del self.runtime, self.model, self.audio_tokenizer, self.tokenizer
        gc.collect()
        torch.cuda.empty_cache()
