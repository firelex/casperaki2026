"""Beat and bar-start tracking with Beat This! (CPJKU, ISMIR 2024, MIT).

Usage: python beat_track.py <audio.wav>
Prints one JSON object: {"beats": [seconds...], "downbeats": [seconds...]}.
Any failure raises (non-zero exit with the traceback on stderr).
"""
import json
import sys

from beat_this.inference import File2Beats


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: beat_track.py <audio.wav>")
    track = File2Beats(checkpoint_path="final0", device="cpu", dbn=False)
    beats, downbeats = track(sys.argv[1])
    json.dump({"beats": [round(float(b), 4) for b in beats], "downbeats": [round(float(d), 4) for d in downbeats]}, sys.stdout)


if __name__ == "__main__":
    main()
