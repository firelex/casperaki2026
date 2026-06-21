"""Shared helpers for serving adapters.

Many models ship their own HTTP server; the cleanest integration is to run that
server as a child process and translate its API into the harness's uniform
blocking `generate`. Those adapters share a lot of boilerplate — JSON-over-HTTP,
launching the child server and waiting for it to become healthy, and streaming
the produced file to the job's out_dir. The model-agnostic pieces live here so a
new adapter (e.g. another music/voice model) only writes what's genuinely
specific to *its* model's API.

Importable as `import adapter_common` because services/_serving is sys.path[0]
(the directory of harness.py, the invoked script) in both the bootstrap and the
re-exec'd serve phase. Only stdlib is used, so it loads under base python too.
"""
from __future__ import annotations

import json
import subprocess
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


def http_json(url, payload=None, timeout=600):
    """GET (payload=None) or POST a JSON body, returning the decoded response."""
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data,
        headers={"content-type": "application/json"} if data else {},
        method="POST" if data is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def post_multipart(url, fields=None, files=None, timeout=600):
    """POST multipart/form-data and return the decoded JSON response.

    `fields` is a {name: str} dict of plain form fields; `files` is a
    {name: (filename, bytes, content_type)} dict of file parts. Used by adapters
    that must upload an input file (e.g. a reference track) to a model server
    whose API accepts inline multipart uploads rather than JSON.
    """
    boundary = "----casperaki" + uuid.uuid4().hex
    parts: list[bytes] = []
    for name, value in (fields or {}).items():
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        parts.append(f"{value}\r\n".encode())
    for name, (filename, content, ctype) in (files or {}).items():
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode()
        )
        parts.append(f"Content-Type: {ctype}\r\n\r\n".encode())
        parts.append(content)
        parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def launch_server(argv, cwd, env, log, label="server"):
    """Start a child server process (stdio inherited), logging the launch."""
    argv = [str(a) for a in argv]
    log(f"starting {label}: {' '.join(argv)}")
    return subprocess.Popen(argv, cwd=str(cwd), env=env)


def wait_until_healthy(proc, is_healthy, timeout, log, label="server", interval=3):
    """Poll `is_healthy()` until it returns truthy, the proc dies, or we time out.

    `is_healthy` is a no-arg callable returning truthy when the server is ready;
    it may raise while the server is still coming up (treated as not-ready-yet).
    Raises RuntimeError on early exit or timeout.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"{label} exited early (code {proc.returncode})")
        try:
            if is_healthy():
                log(f"{label} healthy")
                return
        except Exception:  # noqa: BLE001 — server not up yet
            pass
        time.sleep(interval)
    raise RuntimeError(f"{label} did not become healthy in {timeout}s")


def download_file(url, out_path, timeout=120):
    """Stream `url` to `out_path` in chunks. Returns the Path."""
    out_path = Path(out_path)
    with urllib.request.urlopen(url, timeout=timeout) as r, open(out_path, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    return out_path


def quote_path(path):
    """Percent-encode a filesystem path for use in a query string."""
    return urllib.parse.quote(path, safe="")
