"""Train the hum-to-notes model (hum_pitch/model.py): ONE run, ONE epoch, final checkpoint is the one scored.

  python scripts/train.py --features <dir with r1-train.npz/.jsonl, r1-dev.*> --train r1-train [r2b-train] --dev r1-dev [r2b-dev] \
      --run-dir <runs>/<name> [--limit 2000 for a pilot]

Every training clip is seen once, transposed by a random -6..+5 semitones (input pitch, reference pitch and key
target move together; the correction targets do not change), so every key is equally common and absolute pitch
says nothing about the key. Dev (round-one dev, no shared melody family) is evaluated at step 0, every --eval-every
steps and at the end; events go to <run-dir>/events.jsonl. Saves <run-dir>/final.pt.
"""
import argparse
import json
import math
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from hum_pitch.model import HumNotes, frame_labels, model_inputs, reference_pitch  # noqa: E402


KEY_SOURCES = {"exact"}  # stored keys trained on (set by --key-sources)


def load(feat_dir: Path, name: str, limit: int = 0) -> list[dict]:
    z = np.load(feat_dir / f"{name}.npz")
    metas = [json.loads(l) for l in (feat_dir / f"{name}.jsonl").read_text().splitlines()]
    fo, no = z["frame_offsets"], z["note_offsets"]
    feat, notes = z["feat"], z["notes"]
    clips = []
    for i, m in enumerate(metas[:limit] if limit else metas):
        clips.append({"id": m["id"], "feat": feat[fo[i]:fo[i + 1]], "notes": notes[no[i]:no[i + 1]], "sig": np.asarray(m["sig_soft"], np.float32),
                      "key_label": m["key_label"] if m["key_source"] in KEY_SOURCES else None})
    return clips


def example(c: dict, shift: int):
    f = c["feat"].copy()
    v = f[:, 1] > 0.5
    f[v, 0] += shift
    ref = reference_pitch(f)
    notes = c["notes"].copy()
    notes[:, 2] += shift
    onset, active, delta = frame_labels(len(f), notes, ref)
    if c["key_label"] is None:
        sig, k24 = np.roll(c["sig"], shift), -1
    else:  # a stored key: one-hot key signature (relative-major tonic) and the 24-class key, both transposed
        tonic, minor = (c["key_label"] + shift) % 12, c["key_label"] >= 12
        sig = np.zeros(12, np.float32)
        sig[(tonic + 3) % 12 if minor else tonic] = 1.0
        k24 = tonic + 12 * minor
    return model_inputs(f, ref), onset, active, delta, sig, k24


def batch(items, device):
    T = max(len(x[0]) for x in items)
    B = len(items)
    x = np.zeros((B, T, items[0][0].shape[1]), np.float32)
    on, act = np.zeros((B, T), np.float32), np.zeros((B, T), np.float32)
    de = np.full((B, T), -1, np.int64)
    mask = np.zeros((B, T), bool)
    sig = np.stack([it[4] for it in items])
    k24 = np.array([it[5] for it in items], np.int64)
    for b, (xi, oi, ai, di, _, _) in enumerate(items):
        n = len(xi)
        x[b, :n], on[b, :n], act[b, :n], de[b, :n], mask[b, :n] = xi, oi, ai, di, True
    t = lambda a: torch.from_numpy(a).to(device)  # noqa: E731
    return t(x), t(on), t(act), t(de), t(mask), t(sig), t(k24)


def losses(model, b, pos_weight):
    x, on, act, de, mask, sig, k24 = b
    lo, la, ld, lk, lk24 = model(x, mask)
    m = mask.float()
    l_on = (F.binary_cross_entropy_with_logits(lo, on, reduction="none", pos_weight=torch.tensor(pos_weight, device=x.device)) * m).sum() / m.sum()
    l_act = (F.binary_cross_entropy_with_logits(la, act, reduction="none") * m).sum() / m.sum()
    l_de = F.cross_entropy(ld.reshape(-1, ld.shape[-1]), de.reshape(-1), ignore_index=-1)
    l_key = -(sig * F.log_softmax(lk, -1)).sum(-1).mean()
    stats = {"delta_acc": ((ld.argmax(-1) == de) & (de >= 0)).sum().item() / max((de >= 0).sum().item(), 1),
             "delta0_acc": ((de == 4)).sum().item() / max((de >= 0).sum().item(), 1),  # the "no correction" shortcut
             "key_in_target": (sig.gather(1, lk.argmax(-1, keepdim=True)).squeeze(1) > 0).float().mean().item()}
    if lk24 is not None and (k24 >= 0).any():
        l_key = l_key + F.cross_entropy(lk24, k24, ignore_index=-1)
        has = k24 >= 0
        stats["key24_acc"] = (lk24.argmax(-1)[has] == k24[has]).float().mean().item()
        stats["key24_clips"] = int(has.sum().item())
    return l_on, l_act, l_de, l_key, stats


@torch.no_grad()
def evaluate(model, dev, device, bs, pos_weight):
    model.eval()
    tot, n = {}, 0
    for i in range(0, len(dev), bs):
        items = [example(c, 0) for c in dev[i:i + bs]]
        l_on, l_act, l_de, l_key, st = losses(model, batch(items, device), pos_weight)
        vals = {"onset": l_on.item(), "active": l_act.item(), "delta": l_de.item(), "key": l_key.item()} | st
        for k, v in vals.items():
            if k in ("key24_acc", "key24_clips"):
                continue
            tot[k] = tot.get(k, 0.0) + v * len(items)
        if "key24_acc" in st:
            k24n = tot.get("_k24n", 0)
            tot["_k24c"] = tot.get("_k24c", 0.0) + st["key24_acc"] * st["key24_clips"]
            tot["_k24n"] = k24n + st["key24_clips"]
        n += len(items)
    model.train()
    out = {k: v / n for k, v in tot.items() if not k.startswith("_")}
    if "_k24n" in tot:
        out["key24_acc"] = tot["_k24c"] / tot["_k24n"]
        out["key24_clips"] = tot["_k24n"]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--features", type=Path, required=True)
    ap.add_argument("--train", nargs="+", required=True, help="feature set names (round two can be added here later)")
    ap.add_argument("--dev", nargs="+", required=True)
    ap.add_argument("--run-dir", type=Path, required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--warmup", type=int, default=100)
    ap.add_argument("--hidden", type=int, default=128)
    ap.add_argument("--pos-weight", type=float, default=4.0)
    ap.add_argument("--key-weight", type=float, default=0.3)
    ap.add_argument("--eval-every", type=int, default=200)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--key24", action="store_true", help="add the 24-class key head, trained on clips with a stored key")
    ap.add_argument("--key-sources", nargs="+", default=["exact"], choices=["exact", "estimated"],
                    help="which stored keys count as labels (default: only keys the generator chose)")
    args = ap.parse_args()
    if args.epochs != 1:
        raise SystemExit("one epoch per run (owner's rule)")
    if args.run_dir.exists():
        raise SystemExit(f"{args.run_dir} exists: runs are never overwritten")
    args.run_dir.mkdir(parents=True)
    device = "cuda"
    if not torch.cuda.is_available():
        raise SystemExit("no GPU visible")
    KEY_SOURCES.clear()
    KEY_SOURCES.update(args.key_sources)
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    train = [c for name in args.train for c in load(args.features, name, args.limit)]
    dev = [c for name in args.dev for c in load(args.features, name)]
    if args.key24 and not any(c["key_label"] is not None for c in train):
        raise SystemExit("--key24 given but no training clip has a stored key")
    model = HumNotes(hidden=args.hidden, key24=args.key24).to(device)
    n_par = sum(p.numel() for p in model.parameters())
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    steps = math.ceil(len(train) / args.batch)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / args.warmup) * 0.5 * (1 + math.cos(math.pi * min(s, steps) / steps)))
    commit = subprocess.run(["git", "-C", str(HERE), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    (args.run_dir / "config.json").write_text(json.dumps(vars(args) | {"features": str(args.features), "run_dir": str(args.run_dir),
                                                                       "n_train": len(train), "n_dev": len(dev), "steps": steps, "params": n_par, "commit": commit}, indent=1))
    ev = open(args.run_dir / "events.jsonl", "a")

    def log(rec):
        ev.write(json.dumps(rec) + "\n")
        ev.flush()
        print(json.dumps(rec), flush=True)

    log({"step": 0, "dev": evaluate(model, dev, device, 32, args.pos_weight), "params": n_par, "train_clips": len(train), "steps": steps})
    order = rng.permutation(len(train))
    t0, run = time.time(), {}
    for s in range(steps):
        idx = order[s * args.batch:(s + 1) * args.batch]
        items = [example(train[i], int(rng.integers(-6, 6))) for i in idx]
        l_on, l_act, l_de, l_key, st = losses(model, batch(items, device), args.pos_weight)
        loss = l_on + l_act + l_de + args.key_weight * l_key
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()
        for k, v in {"loss": loss.item(), "onset": l_on.item(), "active": l_act.item(), "delta": l_de.item(), "key": l_key.item()}.items():
            run[k] = run.get(k, 0.0) + v
        if (s + 1) % 50 == 0:
            log({"step": s + 1, "train": {k: v / 50 for k, v in run.items()}, "lr": sched.get_last_lr()[0], "elapsed_s": round(time.time() - t0)})
            run = {}
        if (s + 1) % args.eval_every == 0 and s + 1 < steps:
            log({"step": s + 1, "dev": evaluate(model, dev, device, 32, args.pos_weight)})
    log({"step": steps, "dev": evaluate(model, dev, device, 32, args.pos_weight), "final": True, "elapsed_s": round(time.time() - t0)})
    torch.save({"state_dict": model.state_dict(), "hidden": args.hidden, "commit": commit, "steps": steps}, args.run_dir / "final.pt")
    log({"saved": str(args.run_dir / "final.pt")})


if __name__ == "__main__":
    main()
