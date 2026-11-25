"""Tests for step reporting and cancel in the serving harness (fake adapters, in-process HTTP server)."""
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import adapter_common as common  # noqa: E402
import harness  # noqa: E402


class FakeAdapter:
    MANIFEST = {"id": "fake", "label": "Fake", "kind": "test"}

    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.ran = []

    def generate(self, handle, params, out_dir, job):
        self.ran.append(params.get("name"))
        mode = params.get("mode")
        if mode == "steps":
            job.step("a", "First step").done("fine", {"n": 2})
            s = job.step("b", "Second step")
            (Path(out_dir) / "x.txt").write_bytes(b"hello")
            s.done("wrote", {}, ["x.txt"])
            return {"file": str(Path(out_dir) / "x.txt"), "kind": "text"}
        if mode == "block":
            job.step("w", "Waiting")
            self.started.set()
            while not self.release.wait(0.01):
                job.check_cancelled()
            job.check_cancelled()
            return {"file": "none", "kind": "text"}
        if mode == "fail":
            s = job.step("f", "Failing")
            s.fail("boom")
            raise RuntimeError("boom")
        if mode == "raise":
            job.step("ok", "Fine").done()
            job.step("r", "Running when it raised")
            raise RuntimeError("model exploded")
        raise AssertionError(mode)


class ThreeArgAdapter:
    MANIFEST = {"id": "old", "label": "Old", "kind": "test"}

    def generate(self, handle, params, out_dir):
        p = Path(out_dir) / "o.txt"
        p.write_text("old")
        return {"file": str(p), "kind": "text"}


def start(adapter, tmp_path):
    jobs = harness.Jobs()
    threading.Thread(target=harness.worker, args=(jobs, adapter, None, tmp_path), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", 0), harness.make_handler(jobs, adapter.MANIFEST, None, None))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"


def call(url, method="GET", body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else (b"" if method == "POST" else None), method=method)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def jcall(*a, **k):
    code, data = call(*a, **k)
    return code, json.loads(data)


def wait_state(base, job, states=("done", "error"), timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        _, r = jcall(f"{base}/result?job={job}")
        if r["state"] in states:
            return r
        time.sleep(0.01)
    raise AssertionError(f"job {job} stuck: {r}")


@pytest.fixture
def fake(tmp_path):
    a = FakeAdapter()
    server, base = start(a, tmp_path)
    yield a, base
    server.shutdown()
    a.release.set()


def test_steps_and_files(fake):
    _, base = fake
    _, r = jcall(f"{base}/generate", "POST", {"mode": "steps"})
    job = r["job_id"]
    res = wait_state(base, job)
    assert res["state"] == "done"
    a, b = res["steps"]
    assert (a["id"], a["label"], a["state"], a["text"], a["numbers"], a["files"]) == ("a", "First step", "done", "fine", {"n": 2}, [])
    assert (b["id"], b["state"], b["files"]) == ("b", "done", ["x.txt"])
    assert a["started"] and a["finished"]
    code, data = call(f"{base}/file?job={job}&name=x.txt")
    assert (code, data) == (200, b"hello")
    code, data = jcall(f"{base}/file?job={job}&name=secret.txt")
    assert code == 404
    code, _ = jcall(f"{base}/file?job={job}&name=../x.txt")
    assert code == 404


def test_running_step_and_failed_step(fake):
    a, base = fake
    _, r = jcall(f"{base}/generate", "POST", {"mode": "block"})
    a.started.wait(5)
    res = jcall(f"{base}/result?job={r['job_id']}")[1]
    assert res["state"] == "running"
    assert res["steps"][0]["state"] == "running" and res["steps"][0]["finished"] is None
    a.release.set()
    wait_state(base, r["job_id"])
    _, r = jcall(f"{base}/generate", "POST", {"mode": "fail"})
    res = wait_state(base, r["job_id"])
    assert res["state"] == "error" and res["error"] == "boom"
    assert res["steps"][0]["state"] == "failed" and res["steps"][0]["text"] == "boom"


def test_cancel_running(fake):
    a, base = fake
    _, r = jcall(f"{base}/generate", "POST", {"mode": "block"})
    a.started.wait(5)
    code, _ = jcall(f"{base}/cancel?job={r['job_id']}", "POST")
    assert code == 200
    res = wait_state(base, r["job_id"])
    assert res["state"] == "error" and res["error"] == "Cancelled"


def test_running_steps_fail_with_the_error(fake):
    _, base = fake
    _, r = jcall(f"{base}/generate", "POST", {"mode": "raise"})
    res = wait_state(base, r["job_id"])
    assert res["state"] == "error" and res["error"] == "model exploded"
    ok, running = res["steps"]
    assert ok["state"] == "done"
    assert (running["state"], running["text"]) == ("failed", "model exploded") and running["finished"]


def test_cancel_fails_the_running_step(fake):
    a, base = fake
    _, r = jcall(f"{base}/generate", "POST", {"mode": "block"})
    a.started.wait(5)
    jcall(f"{base}/cancel?job={r['job_id']}", "POST")
    res = wait_state(base, r["job_id"])
    assert (res["steps"][0]["state"], res["steps"][0]["text"]) == ("failed", "Cancelled")


def test_cancel_queued_never_runs(fake):
    a, base = fake
    _, first = jcall(f"{base}/generate", "POST", {"mode": "block", "name": "first"})
    a.started.wait(5)
    _, second = jcall(f"{base}/generate", "POST", {"mode": "steps", "name": "second"})
    code, _ = jcall(f"{base}/cancel?job={second['job_id']}", "POST")
    assert code == 200
    res = jcall(f"{base}/result?job={second['job_id']}")[1]
    assert res["state"] == "error" and res["error"] == "Cancelled"
    a.release.set()
    wait_state(base, first["job_id"])
    time.sleep(0.1)
    assert a.ran == ["first"]


def test_unknown_job(fake):
    _, base = fake
    assert jcall(f"{base}/result?job=nope") == (404, {"error": "unknown job"})
    assert jcall(f"{base}/cancel?job=nope", "POST") == (404, {"error": "unknown job"})


def test_three_argument_adapter_still_works(tmp_path):
    server, base = start(ThreeArgAdapter(), tmp_path)
    try:
        _, r = jcall(f"{base}/generate", "POST", {})
        res = wait_state(base, r["job_id"])
        assert res["state"] == "done" and res["steps"] == []
        assert call(f"{base}/file?job={r['job_id']}") == (200, b"old")
    finally:
        server.shutdown()


def test_cancelled_is_an_exception():
    assert issubclass(common.Cancelled, Exception)
