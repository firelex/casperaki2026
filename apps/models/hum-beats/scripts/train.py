"""Fine-tune Beat This! (final0) on the hum-beats data: ONE run, one epoch, whole model.

  python scripts/train.py --data-dir /mnt/d/casperaki-data/hum-beats/bt-data \
      --run-dir /mnt/d/casperaki-data/hum-beats/runs/beatthis-hum-<YYYYMMDD-HHMM>

Uses Beat This!'s own data module, Lightning module, loss and cosine warm-up schedule. Changes from their
from-scratch recipe, and why:
  * starts from the final0 weights; learning rate 1e-4 (theirs 8e-4), 100 warm-up steps, cosine decay to 0;
  * max_epochs=1 and no length-based oversampling, so each training clip is seen exactly once;
  * batch 16 without gradient accumulation (theirs 8 x 8): about 1,100 optimiser steps instead of ~270;
  * keeps their online mask augmentation; their pitch / tempo augmentations need 21 pre-shifted copies of
    every spectrogram and add nothing here: the generator already draws tempo uniformly over 60-200 BPM and
    transposes every melody;
  * evaluation does not skip the first 5 s (theirs does, for full songs): our clips are 2-36 s long;
  * validates on dev every 150 steps and logs the training loss every 10 steps to <run>/metrics.csv;
  * their mask augmentation draws masks of 0.1-2 s and assumes pieces longer than that (full songs); our
    shortest clips are about 2 s, where it fails (numpy "high <= 0"; the first run crashed on it at step
    ~1,420). Here a mask is at most half the clip long; everything else about it is unchanged.
"""
import argparse
import json
import time
from pathlib import Path

from pytorch_lightning import Trainer, seed_everything
from pytorch_lightning.callbacks import LearningRateMonitor, ModelCheckpoint
from pytorch_lightning.loggers import CSVLogger

import numpy as np

import beat_this.dataset.dataset as bt_dataset
from beat_this.dataset import BeatDataModule
from beat_this.dataset.augment import apply_mask_excerpt
from beat_this.inference import load_checkpoint
from beat_this.model.pl_module import PLBeatThis
from beat_this.utils import replace_state_dict_key


def augment_mask_short_safe(spect, augmentations: dict, fps: int):
    """Beat This!'s augment_mask_ with each mask at most half the clip long (see the module docstring)."""
    if "mask" not in augmentations:
        return spect
    p = augmentations["mask"]
    count = np.random.randint(p["min_count"], p["max_count"] + 1)
    max_len = min(int(p["max_len"] * fps), len(spect) // 2)
    min_len = min(int(p["min_len"] * fps), max_len)
    if max_len < 2:
        raise ValueError(f"spectrogram of {len(spect)} frames is too short to mask")
    for _ in range(count):
        length = np.random.randint(min_len, max_len + 1)
        start = np.random.randint(0, len(spect) - length)
        apply_mask_excerpt(spect[start: start + length], p["kind"], p["min_parts"], p["max_parts"])
    return spect


bt_dataset.augment_mask_ = augment_mask_short_safe  # the dataset module calls it by this name


class HumPL(PLBeatThis):
    def training_step(self, batch, batch_idx):
        pred = self.model(batch["spect"])
        losses = self._compute_loss(batch, pred)
        self.log("train_loss_step", losses["total"].item(), on_step=True, on_epoch=False, batch_size=len(batch["spect"]))
        self.log("train_loss_beat_step", losses["beat"].item(), on_step=True, on_epoch=False, batch_size=len(batch["spect"]))
        self.log("train_loss_downbeat_step", losses["downbeat"].item(), on_step=True, on_epoch=False, batch_size=len(batch["spect"]))
        return losses["total"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", type=Path, required=True)
    ap.add_argument("--run-dir", type=Path, required=True)
    ap.add_argument("--init", default="final0")
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--warmup-steps", type=int, default=100)
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--num-workers", type=int, default=8)
    ap.add_argument("--val-every", type=int, default=150)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--check-loader", action="store_true", help="only run every training item through the data loader once")
    ap.add_argument("--items", default=None, help="training items per dataset, e.g. humbeats2=all,humbeats=5000 (others dropped)")
    ap.add_argument("--val-datasets", default=None, help="comma list of datasets whose val items validate the run (default: all)")
    ap.add_argument("--freeze-frontend", action="store_true", help="keep the frontend (the early layers that hear the timbre) fixed")
    ap.add_argument("--pos-weights", choices=["data", "init"], default="data",
                    help="loss weights of beat frames: recomputed from the training data (Beat This!'s recipe) or the starting checkpoint's own")
    args = ap.parse_args()
    if args.check_loader:
        dm = BeatDataModule(args.data_dir, batch_size=64, train_length=1500, num_workers=16,
                            augmentations={"mask": {"kind": "permute", "min_count": 1, "max_count": 6, "min_len": 0.1, "max_len": 2, "min_parts": 5, "max_parts": 9}},
                            test_dataset="humbeats-no-test", no_val=False, spect_fps=50, length_based_oversampling_factor=0)
        dm.setup("fit")
        n = sum(len(b["spect"]) for b in dm.train_dataloader())
        print(f"data loader ok: {n} training items")
        return
    if args.run_dir.exists() and any(args.run_dir.iterdir()):
        raise SystemExit(f"{args.run_dir} is not empty: one run per directory")
    args.run_dir.mkdir(parents=True, exist_ok=True)
    seed_everything(args.seed, workers=True)

    dm = BeatDataModule(
        args.data_dir, batch_size=args.batch_size, train_length=1500, num_workers=args.num_workers,
        augmentations={"mask": {"kind": "permute", "min_count": 1, "max_count": 6, "min_len": 0.1, "max_len": 2, "min_parts": 5, "max_parts": 9}},
        test_dataset="humbeats-no-test", no_val=False, spect_fps=50, length_based_oversampling_factor=0,
    )
    dm.setup("fit")
    mix = {}
    if args.items:
        rng = np.random.default_rng(args.seed)
        wanted = dict(x.split("=") for x in args.items.split(","))
        kept = []
        for ds, n in wanted.items():
            its = [it for it in dm.train_dataset.items if str(it["spect_path"]).split("/", 1)[0] == ds]
            if not its:
                raise SystemExit(f"no training items from dataset {ds}")
            if n != "all":
                if int(n) > len(its):
                    raise SystemExit(f"asked for {n} items of {ds}, only {len(its)} exist")
                its = [its[i] for i in rng.choice(len(its), int(n), replace=False)]
            kept.extend(its)
            mix[ds] = len(its)
        dm.train_dataset.items = kept
    if args.val_datasets:
        vds = set(args.val_datasets.split(","))
        dm.val_dataset.items = [it for it in dm.val_dataset.items if str(it["spect_path"]).split("/", 1)[0] in vds]
        if not dm.val_dataset.items:
            raise SystemExit(f"no validation items from {vds}")
    ckpt = load_checkpoint(args.init, "cpu")
    pos_weights = dm.get_train_positive_weights(widen_target_mask=3) if args.pos_weights == "data" else dict(ckpt["hyper_parameters"]["pos_weights"])
    hp = dict(ckpt["hyper_parameters"])
    hp.update(lr=args.lr, warmup_steps=args.warmup_steps, max_epochs=1, pos_weights=pos_weights, eval_trim_beats=0, use_dbn=False)
    model = HumPL(**hp)
    model.model.load_state_dict(replace_state_dict_key(ckpt["state_dict"], "model.", ""), strict=True)
    if args.freeze_frontend:
        for p in model.model.frontend.parameters():
            p.requires_grad = False
    info = {"init": args.init, "init_pos_weights": ckpt["hyper_parameters"]["pos_weights"], "pos_weights": pos_weights,
            "train_items": len(dm.train_dataset), "val_items": len(dm.val_dataset), "train_mix": mix,
            "trainable_params": sum(p.numel() for p in model.parameters() if p.requires_grad), "args": {k: str(v) for k, v in vars(args).items()},
            "steps": len(dm.train_dataset.items) // args.batch_size, "started": time.strftime("%Y-%m-%d %H:%M:%S")}
    (args.run_dir / "run.json").write_text(json.dumps(info, indent=1))
    print(json.dumps(info, indent=1), flush=True)

    trainer = Trainer(
        max_epochs=1, accelerator="gpu", devices=[0], precision="16-mixed", logger=CSVLogger(str(args.run_dir), name="", version=""),
        callbacks=[LearningRateMonitor(logging_interval="step"),
                   ModelCheckpoint(dirpath=str(args.run_dir), filename="step{step}", every_n_train_steps=300, save_top_k=-1, save_last=False)],
        log_every_n_steps=10, val_check_interval=args.val_every, num_sanity_val_steps=0, enable_progress_bar=False,
    )
    print("dev score of the starting model:", flush=True)
    trainer.validate(model, dm)
    trainer.fit(model, dm)
    trainer.save_checkpoint(str(args.run_dir / "final.ckpt"))
    info["finished"] = time.strftime("%Y-%m-%d %H:%M:%S")
    info["global_step"] = trainer.global_step
    (args.run_dir / "run.json").write_text(json.dumps(info, indent=1))
    print("done", info, flush=True)


if __name__ == "__main__":
    main()
