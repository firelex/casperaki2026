"""SoulX-Singer's decoder layer on transformers 4.57 (pipeline.soulx_compat) computes what it computed on 4.41.2.

The reference numbers come from the same seeded layer and inputs run through SoulX's unpatched layer in the SoulX
repo's own venv (transformers 4.41.2, torch 2.8); there the shim's output matched with a max abs difference of 0.0.
"""
import sys

import pytest
import torch

from pipeline import paths

sys.path.append(str(paths.SOULX_REPO))


def case(layer_cls):
    from transformers import LlamaConfig

    torch.manual_seed(0)
    cfg = LlamaConfig(hidden_size=128, num_attention_heads=2, max_position_embeddings=4096, intermediate_size=512)
    layer = layer_cls(cfg, layer_idx=0).eval()
    g = torch.Generator().manual_seed(1)
    for _, p in sorted(layer.named_parameters()):
        with torch.no_grad():
            p.copy_(torch.randn(p.shape, generator=g) * 0.05)
    x = torch.randn(2, 37, 128, generator=g)
    cond = torch.randn(2, 128, generator=g)
    mask = torch.zeros(2, 1, 37, 37)
    mask[1, :, :, 30:] = torch.finfo(torch.float32).min  # the second item is 30 frames long
    pos = torch.arange(37).unsqueeze(0)
    with torch.no_grad():
        return layer(x, cond_embedding=cond, attention_mask=mask, position_ids=pos)[0]


def test_the_patched_layer_matches_transformers_4_41():
    from pipeline import soulx_compat

    soulx_compat.install()
    from soulxsinger.models.modules.llama import LlamaNARDecoderLayer

    y = case(LlamaNARDecoderLayer)
    assert y[0, 0, :4].tolist() == pytest.approx([-0.785309, -0.582668, -1.092448, -1.333871], abs=1e-5)
    assert y[1, 36, :4].tolist() == pytest.approx([-1.497474, 1.017867, -0.693515, -0.916961], abs=1e-5)
    assert y.sum().item() == pytest.approx(-110.054, abs=1e-2)
    assert y.abs().sum().item() == pytest.approx(7548.4658, abs=1e-2)
