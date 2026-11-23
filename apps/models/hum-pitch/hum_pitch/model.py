"""The hum-to-notes model: a small bidirectional GRU over SwiftF0 frames (16 ms).

Inputs per frame (scripts/features.py): SwiftF0 pitch (MIDI, 0 when unvoiced), voiced, confidence, loudness, onset
strength. Outputs per frame: note onset, note active, and the intended pitch as a correction of -4..+4 semitones to
the tracked pitch rounded to a semitone (the "reference": the frame's own SwiftF0 pitch, or the nearest voiced
frame's when unvoiced). Predicting a correction rather than an absolute pitch keeps the head small and makes it
independent of the register. Per clip: a key signature (12 classes, relative-major tonic), from attention pooling.
The pitch-class features (sin/cos of the tracked pitch on the 12-semitone circle) let the network learn scale
context; transposition augmentation in training keeps it from tying keys to absolute pitch.
"""
import numpy as np
import torch
from torch import nn

N_DELTA = 9  # corrections -4..+4
FRAME_S = 0.016


def reference_pitch(feat: np.ndarray) -> np.ndarray:
    """Per frame: the tracked pitch, filled from the nearest voiced frame where unvoiced (NaN if none is voiced)."""
    m = feat[:, 0].astype(np.float64)
    v = feat[:, 1] > 0.5
    idx = np.flatnonzero(v)
    if len(idx) == 0:
        return np.full(len(m), np.nan)
    pos = np.searchsorted(idx, np.arange(len(m)))
    left = idx[np.clip(pos - 1, 0, len(idx) - 1)]
    right = idx[np.clip(pos, 0, len(idx) - 1)]
    t = np.arange(len(m))
    near = np.where(np.abs(t - left) <= np.abs(right - t), left, right)
    return m[near]


def model_inputs(feat: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """(frames, 10) network input from the stored features and the reference pitch."""
    m, v = feat[:, 0], feat[:, 1]
    r = np.nan_to_num(ref, nan=60.0)
    has = np.isfinite(ref).astype(np.float32)
    ang12 = 2 * np.pi * r / 12.0
    ang1 = 2 * np.pi * np.where(v > 0.5, m, r)
    x = np.stack([(r - 60.0) / 24.0 * has, v, feat[:, 2], feat[:, 3], feat[:, 4],
                  np.sin(ang12) * has, np.cos(ang12) * has, np.sin(ang1) * has, np.cos(ang1) * has,
                  (np.where(v > 0.5, m, r) - np.round(r)) * has], 1)
    return x.astype(np.float32)


class HumNotes(nn.Module):
    def __init__(self, n_in: int = 10, hidden: int = 128, layers: int = 2, dropout: float = 0.1):
        super().__init__()
        self.inp = nn.Sequential(nn.Linear(n_in, hidden), nn.GELU())
        self.conv = nn.Conv1d(hidden, hidden, 5, padding=2)
        self.gru = nn.GRU(hidden, hidden, num_layers=layers, batch_first=True, bidirectional=True, dropout=dropout)
        self.frame = nn.Sequential(nn.Linear(2 * hidden, hidden), nn.GELU(), nn.Linear(hidden, 2 + N_DELTA))
        self.att = nn.Linear(2 * hidden, 1)
        self.key = nn.Sequential(nn.Linear(2 * hidden, hidden), nn.GELU(), nn.Linear(hidden, 12))

    def forward(self, x: torch.Tensor, mask: torch.Tensor):
        """x (B, T, n_in), mask (B, T) bool. Returns onset logits (B, T), active logits (B, T),
        correction logits (B, T, 9), key logits (B, 12)."""
        h = self.inp(x)
        h = h + torch.relu(self.conv(h.transpose(1, 2)).transpose(1, 2))
        lengths = mask.sum(1).cpu()
        packed = nn.utils.rnn.pack_padded_sequence(h, lengths, batch_first=True, enforce_sorted=False)
        out, _ = self.gru(packed)
        out, _ = nn.utils.rnn.pad_packed_sequence(out, batch_first=True, total_length=x.shape[1])
        f = self.frame(out)
        a = self.att(out).squeeze(-1).masked_fill(~mask, -1e9)
        pooled = (torch.softmax(a, 1).unsqueeze(-1) * out).sum(1)
        return f[..., 0], f[..., 1], f[..., 2:], self.key(pooled)


def frame_labels(n_frames: int, notes: np.ndarray, ref: np.ndarray):
    """Per-frame targets: onset (soft: 1 at the onset frame, 0.5 next to it), active, correction class (-1 = no target:
    no note, no reference pitch, or a correction outside -4..+4)."""
    onset = np.zeros(n_frames, np.float32)
    active = np.zeros(n_frames, np.float32)
    delta = np.full(n_frames, -1, np.int64)
    for on, off, p in notes:
        a, b = int(round(on / FRAME_S)), int(round(off / FRAME_S))
        a, b = max(a, 0), min(max(b, a + 1), n_frames)
        if a >= n_frames:
            continue
        active[a:b] = 1
        for k, val in ((a, 1.0), (a - 1, 0.5), (a + 1, 0.5)):
            if 0 <= k < n_frames:
                onset[k] = max(onset[k], val)
        seg = ref[a:b]
        ok = np.isfinite(seg)
        d = np.full(b - a, -1, np.int64)
        dd = (int(p) - np.round(seg[ok])).astype(np.int64)
        d[ok] = np.where(np.abs(dd) <= 4, dd + 4, -1)
        delta[a:b] = d
    return onset, active, delta


def decode(onset_p: np.ndarray, active_p: np.ndarray, delta_p: np.ndarray, ref: np.ndarray,
           t_on: float, t_act: float, min_frames: int = 3) -> list[list]:
    """Notes [[onset_s, offset_s, midi], ...]: a note starts at an onset peak above t_on (or where activity rises above
    t_act outside a note) and ends where activity falls below t_act or at the next onset; its pitch is the one with
    the largest summed probability over its frames (reference + correction)."""
    T = len(onset_p)
    peaks = set(i for i in range(T) if onset_p[i] >= t_on and onset_p[i] == onset_p[max(0, i - 2):i + 3].max())
    notes, start = [], None

    def close(s, e):
        if e - s < min_frames:
            return
        votes = {}
        for t in range(s, e):
            if not np.isfinite(ref[t]):
                continue
            base = int(np.round(ref[t]))
            for k in range(N_DELTA):
                votes[base + k - 4] = votes.get(base + k - 4, 0.0) + float(delta_p[t, k])
        if votes:
            notes.append([s * FRAME_S, e * FRAME_S, max(votes, key=votes.get)])

    for t in range(T):
        if t in peaks and active_p[t] >= t_act * 0.5:
            if start is not None:
                close(start, t)
            start = t
        elif start is None and active_p[t] >= t_act:
            start = t
        elif start is not None and active_p[t] < t_act:
            close(start, t)
            start = None
    if start is not None:
        close(start, T)
    return notes
