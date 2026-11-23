"""Round-two generation (see hum_beats/generate2.py).

  python scripts/generate2.py --out <dir> --counts train=16000,dev=600,test=1000,test-unseen=500 \
      --soulx-share train=0.33,dev=0.4,test=0.4,test-unseen=0.4 --stage synth|jobs|finish [--workers 24]

  synth   render every non-SoulX clip end to end
  jobs    write a SoulX job (+ pickled state) for every SoulX clip into <out>/soulx-jobs/
  finish  turn finished SoulX renders into clips (alignment check, pollution, labels); runs until the
          workers are done (<out>/soulx-jobs/ALL_SUBMITTED and no jobs left), rejected clips listed in
          <out>/soulx-rejected.jsonl
"""
import argparse
import json
import os
import pickle
import sys
import time
from multiprocessing import Pool
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hum_beats import generate2 as g2  # noqa: E402

SOULX_REPO = Path(__file__).resolve().parents[2] / "services" / "soulx-singer" / "repo"
CACHE = Path.home() / ".cache/casperaki/hum-beats-sounds"
_CTX = None
_OUT = None
_JOBS = None


def _init(out, jobs_dir):
    global _CTX, _OUT, _JOBS
    os.environ["OMP_NUM_THREADS"] = "1"
    _CTX = g2.Context(CACHE, SOULX_REPO)
    _OUT = Path(out)
    _JOBS = Path(jobs_dir)


def _summary(meta):
    return {k: meta[k] for k in ("clip_id", "split", "family", "meter", "n_bars", "bpm", "style", "timing", "start_mode", "duration_s")} | {
        "lead_group": meta["lead"]["group"], "timbre": meta["lead"]["timbre"], "pollution": meta["pollution"]["level"], "source": meta["score"]["source"]}


def _synth(row):
    st = g2.make_state(row, _CTX)
    audio, sinfo, stored = g2.render_synth(st, _CTX)
    return _summary(g2.finish(st, audio, sinfo, stored, _OUT / row["split"]))


def _job(row):
    st = g2.make_state(row, _CTX)
    job = g2.soulx_job(st, _CTX)
    d = _JOBS
    with open(d / f"{row['clip_id']}.state.pkl", "wb") as f:
        pickle.dump(st, f)
    tmp = d / f"{row['clip_id']}.job.tmp"
    tmp.write_text(json.dumps(job))
    tmp.rename(d / f"{row['clip_id']}.job.json")  # visible to the workers only when complete
    return row["clip_id"]


def _finish(wav):
    wav = Path(wav)
    cid = wav.name.split(".soulx.wav")[0]
    state_path = wav.with_name(f"{cid}.state.pkl")
    with open(state_path, "rb") as f:
        st = pickle.load(f)
    audio = g2.soulx_audio(wav)
    align = g2.check_soulx_alignment(audio, st["perf"])
    pitch = g2.check_soulx_pitch(audio, st["cents"])
    ok = (align["checked_notes"] >= 2 and align["within_70ms"] >= 0.6 and abs(align["median_ms"]) <= 50
          and pitch["octave_off"] is not None and pitch["octave_off"] <= 0.15)
    if not ok:
        rej = wav.parent / "rejected"
        rej.mkdir(exist_ok=True)
        for f in (wav, wav.with_name(f"{cid}.soulx.json"), state_path):
            f.rename(rej / f.name)  # kept for inspection, out of the finisher's way
        return {"clip_id": cid, "rejected": {"alignment": align, "pitch": pitch}, "duration_s": st["dur"]}
    render_info = json.loads(wav.with_name(f"{cid}.soulx.json").read_text())
    sinfo = {"soulx": {"prompt": st["lead"]["prompt"], "text": st["lead"]["text"], "alignment": align, "pitch_check": pitch, **render_info}}
    meta = g2.finish(st, audio, sinfo, st["cents"], _OUT / st["row"]["split"])
    wav.unlink()
    state_path.unlink()
    wav.with_name(f"{cid}.soulx.json").unlink()
    return _summary(meta) | {"soulx_alignment": align, **render_info}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--counts", required=True)
    ap.add_argument("--soulx-share", required=True)
    ap.add_argument("--stage", choices=["synth", "jobs", "finish"], required=True)
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--jobs-dir", type=Path, required=True, help="SoulX job folder; keep it on a Linux disk (listing /mnt/d is slow)")
    args = ap.parse_args()
    counts = {k: int(v) for k, v in (x.split("=") for x in args.counts.split(","))}
    share = {k: float(v) for k, v in (x.split("=") for x in args.soulx_share.split(","))}
    rows = g2.make_plan2(counts, share)
    args.out.mkdir(parents=True, exist_ok=True)
    args.jobs_dir.mkdir(parents=True, exist_ok=True)
    (args.out / "plan.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    t = time.time()
    with Pool(args.workers, initializer=_init, initargs=(str(args.out), str(args.jobs_dir))) as pool:
        if args.stage == "synth":
            todo = [r for r in rows if r["render"] == "synth"]
            with open(args.out / "index-synth.jsonl", "w") as idx:
                for i, s in enumerate(pool.imap_unordered(_synth, todo, chunksize=4)):
                    idx.write(json.dumps(s) + "\n")
                    if (i + 1) % 1000 == 0:
                        print(f"{i + 1}/{len(todo)} synth clips, {time.time() - t:.0f} s", flush=True)
            print(f"synth done: {len(todo)} clips in {time.time() - t:.0f} s")
        elif args.stage == "jobs":
            todo = [r for r in rows if r["render"] == "soulx"]
            for i, _ in enumerate(pool.imap_unordered(_job, todo, chunksize=8)):
                if (i + 1) % 1000 == 0:
                    print(f"{i + 1}/{len(todo)} jobs, {time.time() - t:.0f} s", flush=True)
            (args.jobs_dir / "ALL_SUBMITTED").touch()
            print(f"jobs done: {len(todo)} in {time.time() - t:.0f} s")
        else:
            jobs_dir = args.jobs_dir
            done = 0
            with open(args.out / "index-soulx.jsonl", "a") as idx, open(args.out / "soulx-rejected.jsonl", "a") as rej:
                while True:
                    wavs = sorted(jobs_dir.glob("*.soulx.wav"))
                    # a wav is complete once its job file is gone (the worker deletes the claimed job after writing)
                    ready = [str(w) for w in wavs if not list(jobs_dir.glob(w.name.split(".soulx.wav")[0] + ".job.json*"))]
                    for res in pool.imap_unordered(_finish, ready, chunksize=2):
                        (rej if "rejected" in res else idx).write(json.dumps(res) + "\n")
                        done += 1
                    idx.flush()
                    rej.flush()
                    left = list(jobs_dir.glob("*.job.json*")) + list(jobs_dir.glob("*.soulx.wav"))
                    if (jobs_dir / "ALL_SUBMITTED").exists() and not left:
                        break
                    if not ready:
                        time.sleep(10)
            print(f"finish done: {done} SoulX clips handled in {time.time() - t:.0f} s")


if __name__ == "__main__":
    main()
