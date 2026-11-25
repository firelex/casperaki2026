"""SoulX-Singer on this venv's transformers (4.57.6, pinned by YuE2's yue2_infer).

SoulX-Singer's DiffLlama (soulxsinger/models/modules/llama.py, shared tree, read-only here) was written for
transformers 4.41.2: its decoder layer calls Llama attention without rotary position embeddings (4.41's attention made
them itself from position_ids) and unpacks three return values (4.57 returns two). `install()` replaces that layer's
forward with the same computation written for 4.57: rotary embeddings from the layer's own config (head size 64, base
10000, as 4.41 made them) passed in, eager attention (4.41's default for these configs), the same adaptive norms, MLP and
residuals. Checked against 4.41 on one layer (see tests/test_soulx_compat.py for the reference values' origin).
"""
from __future__ import annotations

_INSTALLED = False


def _forward(self, hidden_states, cond_embedding, attention_mask=None, position_ids=None, past_key_value=None,
             output_attentions=False, use_cache=False):
    from transformers.models.llama.modeling_llama import LlamaRotaryEmbedding

    if past_key_value is not None or output_attentions:
        raise NotImplementedError("SoulX layer shim: past key values and attention outputs are not supported")
    rope = getattr(self, "_casperaki_rope", None)
    if rope is None or rope.inv_freq.device != hidden_states.device:
        self.self_attn.config._attn_implementation = "eager"
        rope = LlamaRotaryEmbedding(self.self_attn.config, device=hidden_states.device)
        self._casperaki_rope = rope
    if position_ids is None:
        raise ValueError("SoulX layer shim: position_ids are required")
    residual = hidden_states
    hidden_states = self.input_layernorm(hidden_states, cond_embedding=cond_embedding)
    hidden_states, _ = self.self_attn(hidden_states=hidden_states, position_embeddings=rope(hidden_states, position_ids),
                                      attention_mask=attention_mask)
    hidden_states = residual + hidden_states
    residual = hidden_states
    hidden_states = self.post_attention_layernorm(hidden_states, cond_embedding=cond_embedding)
    hidden_states = self.mlp(hidden_states)
    # DiffLlama asks for a cache (its config's use_cache) and collects outputs[1], then discards it: no cache is kept
    return (residual + hidden_states, None) if use_cache else (residual + hidden_states,)


def install() -> None:
    """Patch SoulX's LlamaNARDecoderLayer.forward (idempotent). The SoulX repo must be on sys.path."""
    global _INSTALLED
    if _INSTALLED:
        return
    import transformers
    from soulxsinger.models.modules import llama

    if not transformers.__version__.startswith("4.57."):
        raise RuntimeError(f"SoulX layer shim is written for transformers 4.57, found {transformers.__version__}")
    llama.LlamaNARDecoderLayer.forward = _forward
    _INSTALLED = True
