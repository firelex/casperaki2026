#!/usr/bin/env bash
# Round two's one full run, chained so it needs no attention:
#   wait for the SoulX finisher and the song renderer -> complete the training layouts -> train (one epoch from
#   final0: every round-two-b clip and every song excerpt, final0's loss weights, lr 1e-4, 100 warm-up steps, batch 16)
#   -> weights-only checkpoint -> score final (with and without DBN) on the same files as final0 -> merged summary.
set -euo pipefail
V=~/.local/share/casperaki/venvs/hum-beats/bin/python
H=~/apps/casperaki/apps/models/hum-beats
D=/mnt/d/casperaki-data/hum-beats
cd $H
while tmux has-session -t humfinish 2>/dev/null || tmux has-session -t humsongs 2>/dev/null; do sleep 30; done
echo "generation finished $(date)"
$V scripts/make_bt_data.py --data $D/r2b --out $D/bt-data --dataset humbeats2b --workers 12
$V scripts/make_bt_data.py --data $D/songs --out $D/bt-data --dataset songs --splits train=train --workers 12
RUN=beatthis-hum-$(date +%Y%m%d-%H%M)
echo "run $RUN $(date)"
$V scripts/train.py --data-dir $D/bt-data --run-dir $D/runs/$RUN --items humbeats2b=all,songs=all --val-datasets humbeats2b \
  --pos-weights init --lr 1e-4 --warmup-steps 100 --batch-size 16
$V scripts/strip_checkpoint.py $D/runs/$RUN/final.ckpt $D/runs/$RUN/final-weights.ckpt
while tmux has-session -t humscore0 2>/dev/null; do sleep 30; done
SETS="humtrans-test=$D/test-humtrans singing-gtzan-vocals=$D/test-gtzan-vocals@odd music-gtzan-mix=$D/test-gtzan-mix@odd \
synthetic-r2-test=$D/r2b/test synthetic-r2-test-unseen=$D/r2b/test-unseen synthetic-r1-test=$D/full/test \
synthetic-r1-test-unseen=$D/full/test-unseen humtrans-dev=$D/dev-humtrans gtzan-vocals-dev=$D/test-gtzan-vocals@even gtzan-mix-dev=$D/test-gtzan-mix@even"
$V scripts/score.py --models $D/runs/$RUN/final-weights.ckpt --names final --dbn --sets $SETS --out $D/final-scores/$RUN
$V scripts/merge_scores.py --out $D/final-scores/$RUN-vs-final0 $D/final-scores/final0-v2/per_clip.csv $D/final-scores/$RUN/per_clip.csv > /dev/null
if ls ~/casperaki-data/hum-lab/*.json >/dev/null 2>&1; then
  $V scripts/score.py --models final0 $D/runs/$RUN/final-weights.ckpt --names final0 final --dbn --hum-lab ~/casperaki-data/hum-lab --out $D/final-scores/$RUN-hum-lab
fi
echo "all done $RUN $(date)"
