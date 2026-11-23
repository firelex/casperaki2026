"""The AMT spike's decode loop (apps/models/amt-spike/amt_complete.py generate / add_token) with a key-value cache.

The library's sampler feeds the whole context to the model for every token (3 forward passes per note event, each
over up to 1024 tokens). Here the model's past key/values are kept between steps and only the new tokens are fed,
as long as the context the sampler builds still starts with what is cached. When it does not (the history window
slides past 1017 tokens, or the relative-time offset of the history changes), the context is run again in full.
So the tokens fed to the model are exactly the ones the spike feeds; only the work is reused. Everything else
(melody-only decoding, no clipping of controls in the first 50 ms) is the spike's.
"""
from __future__ import annotations

import math

import torch
import torch.nn.functional as F
from anticipation import ops
from anticipation.config import DELTA, TIME_RESOLUTION
from anticipation.sample import future_logits, instr_logits, nucleus, safe_logits
from anticipation.vocab import ANTICIPATE, ATIME_OFFSET, TIME_OFFSET

from amt_complete import melody_only_logits


class KVCache:
    """The model's state after a token sequence; `logits(seq)` returns the next-token logits for seq."""

    def __init__(self, model):
        self.model = model
        self.seq: list[int] = []
        self.past = None
        self.full_runs = 0

    def logits(self, seq: list[int]) -> torch.Tensor:
        n = len(self.seq)
        if self.past is not None and len(seq) > n and seq[:n] == self.seq:
            feed, past = seq[n:], self.past
        else:
            feed, past = seq, None
            self.full_runs += 1
        ids = torch.tensor(feed, device=self.model.device).unsqueeze(0)
        with torch.no_grad():
            out = self.model(ids, past_key_values=past, use_cache=True)
        self.seq, self.past = list(seq), out.past_key_values
        return out.logits[0, -1].float()


def add_token(cache: KVCache, z, tokens, top_p, current_time):
    history = tokens.copy()
    lookback = max(len(tokens) - 1017, 0)
    history = history[lookback:]
    offset = ops.min_time(history, seconds=False)
    history[::3] = [tok - offset for tok in history[::3]]
    new_token = []
    for i in range(3):
        seq = z + history + new_token
        logits = safe_logits(cache.logits(seq), len(seq) - 1)
        if i == 0:
            logits = future_logits(logits, current_time - offset)
        elif i == 2:
            logits = instr_logits(logits, tokens)
            logits = melody_only_logits(logits)
        logits = nucleus(logits, top_p)
        probs = F.softmax(logits, dim=-1)
        new_token.append(int(torch.multinomial(probs, 1)))
    new_token[0] += offset
    return new_token, lookback > 0


def generate(model, start_ticks, end_ticks, prompt_events, controls, top_p):
    """amt_complete.generate with the cache: same arguments, same result shape (events, n_tokens, hit_window)."""
    cache = KVCache(model)
    delta = DELTA * TIME_RESOLUTION
    prompt = ops.pad(prompt_events, start_ticks)
    z = [ANTICIPATE]
    tokens, controls = ops.anticipate(prompt, controls)
    current_time = ops.max_time(prompt, seconds=False)
    hit_window = False
    if controls:
        atime, adur, anote = controls[0:3]
        pending = controls[3:]
        anticipated_time = atime - ATIME_OFFSET
    else:
        anticipated_time = math.inf
    while True:
        while current_time >= anticipated_time - delta:
            tokens.extend([atime, adur, anote])
            if pending:
                atime, adur, anote = pending[0:3]
                pending = pending[3:]
                anticipated_time = atime - ATIME_OFFSET
            else:
                anticipated_time = math.inf
        new_token, windowed = add_token(cache, z, tokens, top_p, max(start_ticks, current_time))
        hit_window = hit_window or windowed
        new_time = new_token[0] - TIME_OFFSET
        if new_time >= end_ticks:
            break
        tokens.extend(new_token)
        if new_time < current_time:
            raise RuntimeError(f"sampled time went backwards: {new_time} < {current_time}")
        current_time = new_time
    events, _ = ops.split(tokens)
    return ops.unpad(events), len(tokens), hit_window



# --------------------------------------------------------------------------- #
# Batched: several samples decoded together, one forward pass per step for all of them.

class _Row:
    def __init__(self, start_ticks, end_ticks, prompt_events, controls, top_p):
        self.start, self.end, self.top_p = start_ticks, end_ticks, top_p
        prompt = ops.pad(prompt_events, start_ticks)
        self.tokens, controls = ops.anticipate(prompt, controls)
        self.current = ops.max_time(prompt, seconds=False)
        self.pending = controls
        self.anticipated = controls[0] - ATIME_OFFSET if controls else math.inf
        self.fed: list[int] = []  # the sequence already in this row's cache
        self.new: list[int] = []  # tokens sampled for the event being written
        self.done = False

    def pull_controls(self):
        delta = DELTA * TIME_RESOLUTION
        while self.current >= self.anticipated - delta:
            self.tokens.extend(self.pending[0:3])
            self.pending = self.pending[3:]
            self.anticipated = self.pending[0] - ATIME_OFFSET if self.pending else math.inf

    def seq(self) -> list[int]:
        if len(self.tokens) > 1017:
            raise RuntimeError("the melody is too long for the model's context window (more than 1017 tokens)")
        if ops.min_time(self.tokens, seconds=False) != 0:
            raise RuntimeError("the history does not start at time 0; the cached batch decoder assumes it does")
        return [ANTICIPATE] + self.tokens + self.new


def generate_batch(model, rows: list[tuple]) -> list[list[int]]:
    """Decode several (start_ticks, end_ticks, prompt_events, controls, top_p) rows together; returns each row's
    events, as amt_complete.generate would (same tokens fed, same logit processing, own sampling per row). Rows that
    finish leave the batch."""
    rs = [_Row(*r) for r in rows]
    for r in rs:
        r.pull_controls()
    dev = model.device
    past = None  # legacy tuple per layer of (key, value), batch = active rows
    mask = None  # (B, cached positions): 1 for real tokens, 0 for padding
    active = list(range(len(rs)))
    sub = 0  # which of the 3 tokens of an event is next
    while active:
        feeds = []
        for i in active:
            r = rs[i]
            s = r.seq()
            if s[: len(r.fed)] != r.fed:
                raise RuntimeError("the sampler's context no longer starts with the cached tokens")
            feeds.append(s[len(r.fed):])
        k = max(len(f) for f in feeds)
        ids = torch.zeros(len(active), k, dtype=torch.long, device=dev)
        new_mask = torch.zeros(len(active), k, dtype=torch.long, device=dev)
        pos = torch.zeros(len(active), k, dtype=torch.long, device=dev)
        for j, (i, f) in enumerate(zip(active, feeds)):
            ids[j, : len(f)] = torch.tensor(f, device=dev)
            new_mask[j, : len(f)] = 1
            pos[j] = len(rs[i].fed) + torch.arange(k, device=dev)
        full_mask = new_mask if mask is None else torch.cat([mask, new_mask], 1)
        with torch.no_grad():
            out = model(ids, past_key_values=past, attention_mask=full_mask, position_ids=pos, use_cache=True)
        past, mask = out.past_key_values, full_mask
        last = torch.tensor([len(f) - 1 for f in feeds], device=dev)
        logits_all = out.logits[torch.arange(len(active), device=dev), last].float()
        keep = []
        for j, i in enumerate(active):
            r = rs[i]
            r.fed = r.seq()
            logits = safe_logits(logits_all[j], len(r.fed) - 1)
            if sub == 0:
                logits = future_logits(logits, max(r.start, r.current))  # history offset is 0 (checked in seq)
            elif sub == 2:
                logits = melody_only_logits(instr_logits(logits, r.tokens))
            logits = nucleus(logits, r.top_p)
            r.new.append(int(torch.multinomial(F.softmax(logits, dim=-1), 1)))
            if sub == 2:
                new_time = r.new[0] - TIME_OFFSET
                if new_time >= r.end:
                    r.done = True
                else:
                    if new_time < r.current:
                        raise RuntimeError(f"sampled time went backwards: {new_time} < {r.current}")
                    r.tokens.extend(r.new)
                    r.current = new_time
                    r.pull_controls()
                r.new = []
            if not r.done:
                keep.append(j)
        sub = (sub + 1) % 3
        if len(keep) < len(active):
            idx = torch.tensor(keep, device=dev, dtype=torch.long)
            past = tuple((kv[0].index_select(0, idx), kv[1].index_select(0, idx)) for kv in past) if keep else None
            mask = mask.index_select(0, idx) if keep else None
            active = [active[j] for j in keep]
    results = []
    for r in rs:
        events, _ = ops.split(r.tokens)
        results.append(ops.unpad(events))
    return results
