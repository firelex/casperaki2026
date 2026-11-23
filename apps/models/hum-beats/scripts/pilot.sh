#!/usr/bin/env bash
# One pilot training (a short run on a subset, to choose the data mix and settings), then its scores on the
# decision sets (real-hum dev, GTZAN mixes and vocals, even tracks). Decisions only: the final run is separate.
#   scripts/pilot.sh <name> <train.py options...>
set -euo pipefail
NAME=$1; shift
V=~/.local/share/casperaki/venvs/hum-beats/bin/python
H=~/apps/casperaki/apps/models/hum-beats
D=/mnt/d/casperaki-data/hum-beats
RUN=$D/pilots/$NAME
cd $H
$V scripts/train.py --data-dir $D/bt-data --run-dir $RUN "$@"
$V scripts/strip_checkpoint.py $RUN/final.ckpt $RUN/final-weights.ckpt
$V scripts/score.py --models $RUN/final-weights.ckpt --names $NAME \
  --sets dev-humtrans=$D/dev-humtrans gtzan-mix-dev=$D/test-gtzan-mix@even gtzan-vocals-dev=$D/test-gtzan-vocals@even r2-dev=$D/r2/dev r2b-dev=$D/r2b/dev \
  --out $RUN/scores
