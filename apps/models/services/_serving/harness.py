#!/usr/bin/env python3
"""Generic model-serving harness for Casperaki.

One fixed, model-agnostic server. Each model ships a tiny `adapters/<id>.py`
exposing a MANIFEST plus `load(ctx)` and `generate(handle, params, out_dir)`.
The harness:

  * bootstraps (clone repo, create the uv venv, download missing weight files),
  * re-execs into that venv,
  * serves ONE uniform contract:
        GET  /health              -> {"ready": bool, ...}
        POST /generate {params}   -> 202 {"job_id"}
        GET  /result?job=ID       -> {"state": running|done|error, "kind", "error"}
        GET  /file?job=ID         -> streams the generated file
        GET  /file?job=ID&name=F  -> streams a file that one of the job's steps listed
        POST /cancel?job=ID       -> 200 (a queued job is removed, a running one is flagged)

`generate` may take a 4th argument `job` (the harness passes it when the function has four parameters):
`job.step(id, label)` returns a Step (`.done(text, numbers, files)` / `.fail(text)`), `job.cancelled()`, and
`job.check_cancelled()` (raises adapter_common.Cancelled). /result then also lists `steps`.

An adapter may also expose synchronous JSON endpoints: `ROUTES = {"/path": fn}`,
where `fn(handle, headers, body: bytes) -> (status, dict)`. They answer in the
request itself (for quick calls such as transcribing a hum), one at a time per
service, and an exception becomes a 500 with {"error": <message>}. A handler that
wants a 4xx raises `RequestError(status, message)` from adapter_common.

Adapter `generate` is *blocking* (returns {"file","kind"} when done); the
async job semantics live here so the contract is identical for a 5-second
song or a 5-minute video.
"""
from __future__ import annotations

import argparse
import importlib.util
import inspect
import json
import os
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

SERVING_DIR = Path(__file__).resolve().parent
if str(SERVING_DIR) not in sys.path:
    sys.path.insert(0, str(SERVING_DIR))
import adapter_common as common  # noqa: E402
SERVICES_DIR = SERVING_DIR.parent


def log(msg: str) -> None:
    print(f"[harness] {msg}", flush=True)


def load_adapter(adapter: str):
    path = SERVING_DIR / "adapters" / f"{adapter}.py"
    if not path.exists():
        raise SystemExit(f"adapter not found: {path}")
    spec = importlib.util.spec_from_file_location(f"adapter_{adapter}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


# --------------------------------------------------------------------------- #
# Bootstrap (runs under base python)
# --------------------------------------------------------------------------- #

def uv_bin() -> str:
    cand = Path.home() / ".local" / "bin" / "uv"
    return str(cand) if cand.exists() else "uv"


def ensure_repo(manifest: dict, service_dir: Path) -> Path | None:
    repo = manifest.get("repo")
    if not repo:
        return None
    repo_dir = service_dir / repo.get("dir", "repo")
    if not repo_dir.exists():
        log(f"cloning {repo['url']} -> {repo_dir}")
        subprocess.run(
            ["git", "clone", "--depth", "1", *(["-b", repo["branch"]] if repo.get("branch") else []),
             repo["url"], str(repo_dir)],
            check=True,
        )
    return repo_dir


def ensure_venv(manifest: dict, service_dir: Path, repo_dir: Path | None) -> Path:
    venv_dir = service_dir / manifest.get("venv", ".venv")
    if (venv_dir / "bin" / "python").exists():
        return venv_dir
    setup = manifest.get("setup")
    if not setup:
        raise SystemExit(f"venv missing and no `setup` in manifest for {manifest['id']}")
    cwd = repo_dir if (repo_dir and manifest.get("setup_in_repo", True)) else service_dir
    for cmd in setup:
        argv = [uv_bin() if a == "$UV" else a for a in cmd]
        log(f"setup: {' '.join(argv)} (cwd={cwd})")
        subprocess.run(argv, cwd=str(cwd), check=True)
    if not (venv_dir / "bin" / "python").exists():
        raise SystemExit(f"setup ran but venv not found at {venv_dir}")
    return venv_dir


def hf_token() -> str | None:
    """HF token for gated/private weight files: env first, then the token file
    written by `huggingface-cli login` (default ~/.cache/huggingface/token,
    relocatable via HF_TOKEN_PATH or $HF_HOME/token). Mirrors the Node side."""
    tok = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if tok:
        return tok.strip()
    candidates = [
        os.environ.get("HF_TOKEN_PATH"),
        os.path.join(os.path.expanduser(os.environ["HF_HOME"]), "token") if os.environ.get("HF_HOME") else None,
        str(Path.home() / ".cache" / "huggingface" / "token"),
    ]
    for p in candidates:
        if not p:
            continue
        try:
            t = Path(p).read_text().strip()
            if t:
                return t
        except OSError:
            pass
    return None


def download_missing(manifest: dict, models_dir: Path) -> None:
    token = hf_token()
    for f in manifest.get("missing_files", []):
        dest = Path(f["dest"]) if os.path.isabs(f["dest"]) else (models_dir / f["dest"])
        if dest.exists() and dest.stat().st_size > 0:
            continue
        url = f["url"]
        log(f"downloading {url} -> {dest}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        # Only attach the token for huggingface.co so it's never leaked elsewhere.
        host = urlparse(url).hostname or ""
        headers = {}
        if token and (host == "huggingface.co" or host.endswith(".huggingface.co")):
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as r, open(tmp, "wb") as out:
            while chunk := r.read(1 << 20):
                out.write(chunk)
        tmp.rename(dest)


# --------------------------------------------------------------------------- #
# Serve (runs inside the venv)
# --------------------------------------------------------------------------- #

class Ctx:
    def __init__(self, manifest, service_dir, repo_dir, venv_dir, model_dir, port):
        self.manifest = manifest
        self.service_dir = Path(service_dir)
        self.repo_dir = Path(repo_dir) if repo_dir else None
        self.venv_dir = Path(venv_dir) if venv_dir else None
        self.model_dir = Path(model_dir) if model_dir else None
        self.port = port
        self.log = log


class Step:
    """One reported step of a job. Created by `job.step(id, label)`; finish it with `done` or `fail`."""

    def __init__(self, job: "Job", id: str, label: str):
        self._job = job
        self.data = {"id": id, "label": label, "state": "running", "started": time.time(),
                     "finished": None, "text": "", "numbers": {}, "files": []}

    def _finish(self, state: str, text: str, numbers: dict, files: list) -> None:
        with self._job._lock:
            self.data.update(state=state, finished=time.time(), text=text,
                             numbers=dict(numbers), files=list(files))

    def done(self, text: str = "", numbers: dict | None = None, files: list | None = None) -> None:
        self._finish("done", text, numbers or {}, files or [])

    def fail(self, text: str) -> None:
        self._finish("failed", text, {}, [])


class Job:
    """What an adapter's 4-argument `generate` receives: step reporting and the cancel flag."""

    def __init__(self):
        self._lock = threading.Lock()
        self._steps: list[Step] = []
        self._cancel = threading.Event()

    def step(self, id: str, label: str) -> Step:
        s = Step(self, id, label)
        with self._lock:
            self._steps.append(s)
        return s

    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def check_cancelled(self) -> None:
        if self._cancel.is_set():
            raise common.Cancelled("Cancelled")

    def fail_running(self, text: str) -> None:
        """Mark every step still running as failed with `text` (the job ended in an error or was cancelled)."""
        with self._lock:
            running = [s for s in self._steps if s.data["state"] == "running"]
        for s in running:
            s.fail(text)

    def steps(self) -> list[dict]:
        with self._lock:
            return [json.loads(json.dumps(s.data)) for s in self._steps]


class Jobs:
    def __init__(self):
        self._jobs: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._queue: list[tuple[str, dict]] = []
        self._cv = threading.Condition(self._lock)

    def submit(self, params: dict) -> str:
        job_id = uuid.uuid4().hex
        with self._cv:
            self._jobs[job_id] = {"state": "running", "file": None, "kind": None, "error": None,
                                  "job": Job(), "out_dir": None}
            self._queue.append((job_id, params))
            self._cv.notify()
        return job_id

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            j = self._jobs.get(job_id)
            return dict(j) if j else None

    def cancel(self, job_id: str) -> bool:
        """Remove a queued job (it ends "Cancelled" without running) or flag a running one. False if unknown."""
        with self._cv:
            j = self._jobs.get(job_id)
            if not j:
                return False
            j["job"]._cancel.set()
            for i, (qid, _) in enumerate(self._queue):
                if qid == job_id:
                    del self._queue[i]
                    j.update(state="error", error="Cancelled")
                    break
            return True

    def next(self):
        with self._cv:
            while not self._queue:
                self._cv.wait()
            return self._queue.pop(0)

    def finish(self, job_id: str, **fields):
        with self._lock:
            self._jobs.get(job_id, {}).update(fields)


def _takes_job(fn) -> bool:
    return len(inspect.signature(fn).parameters) >= 4


def worker(jobs: Jobs, adapter, handle, out_root: Path):
    while True:
        job_id, params = jobs.next()
        out_dir = out_root / job_id
        out_dir.mkdir(parents=True, exist_ok=True)
        jobs.finish(job_id, out_dir=str(out_dir))
        job = jobs.get(job_id)["job"]
        try:
            log(f"job {job_id}: generating")
            if _takes_job(adapter.generate):
                res = adapter.generate(handle, params, str(out_dir), job)
            else:
                res = adapter.generate(handle, params, str(out_dir))
            jobs.finish(job_id, state="done", file=res["file"], kind=res.get("kind", "file"))
            log(f"job {job_id}: done -> {res['file']}")
        except common.Cancelled:
            log(f"job {job_id}: cancelled")
            job.fail_running("Cancelled")
            jobs.finish(job_id, state="error", error="Cancelled")
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            job.fail_running(str(e))
            jobs.finish(job_id, state="error", error=str(e))


def make_handler(jobs: Jobs, manifest: dict, routes: dict | None = None, handle=None):
    routes = routes or {}
    route_lock = threading.Lock()  # one synchronous call at a time (they share the GPU model)

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quieter
            pass

        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == "/health":
                self._send(200, {"ready": True, "id": manifest["id"],
                                 "label": manifest.get("label"), "kind": manifest.get("kind")})
            elif u.path == "/result":
                job = parse_qs(u.query).get("job", [""])[0]
                j = jobs.get(job)
                if not j:
                    self._send(404, {"error": "unknown job"})
                else:
                    self._send(200, {"state": j["state"], "kind": j["kind"], "error": j["error"],
                                     "steps": j["job"].steps()})
            elif u.path == "/file":
                q = parse_qs(u.query)
                job = q.get("job", [""])[0]
                j = jobs.get(job)
                if j and "name" in q:
                    name = q["name"][0]
                    listed = {f for st in j["job"].steps() for f in st["files"]}
                    if name not in listed:
                        self._send(404, {"error": f"file {name!r} was not listed by any step of this job"})
                        return
                    path = Path(j["out_dir"]) / name
                    if not path.is_file():
                        self._send(404, {"error": f"step file {name!r} is missing on disk"})
                        return
                    self._send_file(path)
                    return
                if not j or j["state"] != "done" or not j["file"]:
                    self._send(404, {"error": "no file for job"})
                    return
                self._send_file(Path(j["file"]))
            else:
                self._send(404, {"error": "not found"})

        def _send_file(self, p: Path):
            import mimetypes
            ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
            data = p.read_bytes()
            self.send_response(200)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(data)))
            self.send_header("content-disposition", f'inline; filename="{p.name}"')
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            u = urlparse(self.path)
            if u.path in routes:
                length = int(self.headers.get("content-length", 0))
                body = self.rfile.read(length) if length else b""
                try:
                    with route_lock:
                        code, obj = routes[u.path](handle, self.headers, body)
                except Exception as e:  # noqa: BLE001
                    status = getattr(e, "status", None)
                    if status is None:
                        traceback.print_exc()
                    self._send(status or 500, {"error": str(e)})
                    return
                self._send(code, obj)
                return
            if u.path == "/cancel":
                job = parse_qs(u.query).get("job", [""])[0]
                if jobs.cancel(job):
                    self._send(200, {"cancelled": True})
                else:
                    self._send(404, {"error": "unknown job"})
                return
            if u.path != "/generate":
                self._send(404, {"error": "not found"})
                return
            length = int(self.headers.get("content-length", 0))
            try:
                params = json.loads(self.rfile.read(length) or b"{}")
            except Exception:  # noqa: BLE001
                self._send(400, {"error": "invalid JSON body"})
                return
            self._send(202, {"job_id": jobs.submit(params)})

    return H


def serve(adapter_name: str, port: int, model_dir: str, service_dir: str, repo_dir, venv_dir):
    adapter = load_adapter(adapter_name)
    manifest = adapter.MANIFEST
    ctx = Ctx(manifest, service_dir, repo_dir, venv_dir, model_dir, port)
    log(f"loading adapter {manifest['id']} …")
    handle = adapter.load(ctx)
    out_root = Path(service_dir) / "outputs"
    out_root.mkdir(parents=True, exist_ok=True)
    jobs = Jobs()
    threading.Thread(target=worker, args=(jobs, adapter, handle, out_root), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(jobs, manifest, getattr(adapter, "ROUTES", None), handle))
    log(f"ready on http://127.0.0.1:{port}")
    server.serve_forever()


# --------------------------------------------------------------------------- #

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--models-dir", default=str(Path.home() / "models"))
    ap.add_argument("--serve", action="store_true", help="internal: already in venv")
    ap.add_argument("--repo-dir", default="")
    ap.add_argument("--venv-dir", default="")
    args = ap.parse_args()

    service_dir = SERVICES_DIR / args.adapter
    service_dir.mkdir(parents=True, exist_ok=True)

    if args.serve:
        serve(args.adapter, args.port, args.models_dir, str(service_dir),
              args.repo_dir or None, args.venv_dir or None)
        return

    # Bootstrap phase under base python.
    adapter = load_adapter(args.adapter)
    manifest = adapter.MANIFEST
    repo_dir = ensure_repo(manifest, service_dir)
    venv_dir = ensure_venv(manifest, service_dir, repo_dir)
    download_missing(manifest, Path(args.models_dir))

    # Re-exec into the venv to serve.
    py = venv_dir / "bin" / "python"
    log(f"re-exec into venv: {py}")
    os.execv(str(py), [str(py), str(SERVING_DIR / "harness.py"),
                       "--serve", "--adapter", args.adapter, "--port", str(args.port),
                       "--models-dir", args.models_dir,
                       "--repo-dir", str(repo_dir or ""), "--venv-dir", str(venv_dir)])


if __name__ == "__main__":
    main()
