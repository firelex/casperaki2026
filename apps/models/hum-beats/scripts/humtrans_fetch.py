"""Fetch single WAV files out of HumTrans's 14.7 GB all_wav.zip with HTTP range requests (no full download).

  python -I scripts/humtrans_fetch.py --out <dir> KEY [KEY ...]
HumTrans (dadinghh2/HumTrans) is CC BY-NC 4.0: evaluation only, never training.
"""
import argparse
import io
import urllib.request
import zipfile
from pathlib import Path

URL = "https://huggingface.co/datasets/dadinghh2/HumTrans/resolve/main/all_wav.zip"


class HTTPRangeFile(io.RawIOBase):
    def __init__(self, url: str):
        self.url = urllib.request.urlopen(urllib.request.Request(url, method="HEAD")).geturl()  # follow the CDN redirect once
        req = urllib.request.Request(self.url, method="HEAD")
        self.size = int(urllib.request.urlopen(req).headers["Content-Length"])
        self.pos = 0

    def seekable(self):
        return True

    def readable(self):
        return True

    def seek(self, offset, whence=0):
        self.pos = {0: offset, 1: self.pos + offset, 2: self.size + offset}[whence]
        return self.pos

    def tell(self):
        return self.pos

    def read(self, n=-1):
        if n is None or n < 0:
            n = self.size - self.pos
        if n == 0 or self.pos >= self.size:
            return b""
        end = min(self.size, self.pos + n) - 1
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}"})
        data = urllib.request.urlopen(req).read()
        self.pos += len(data)
        return data

    def readinto(self, b):
        data = self.read(len(b))
        b[: len(data)] = data
        return len(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("keys", nargs="+")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    zf = zipfile.ZipFile(io.BufferedReader(HTTPRangeFile(URL), buffer_size=1 << 20))
    names = {Path(n).stem: n for n in zf.namelist() if n.endswith(".wav")}
    print(f"{len(names)} wav files in the archive")
    for k in args.keys:
        if k not in names:
            raise KeyError(f"{k} is not in all_wav.zip")
        target = args.out / f"{k}.wav"
        if target.exists():
            continue
        target.write_bytes(zf.read(names[k]))
        print("fetched", target)


if __name__ == "__main__":
    main()
