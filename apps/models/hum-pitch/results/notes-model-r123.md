# Hum-to-notes model, run three (rounds one + two + three, key head on stored keys), 2026-11-23

Run `bigru128-humnotes-r123-20261123-2136` (casdgx01 GPU 2, tmux hum-pitch-train-r123): r1 + r2b + r3 train, 62,942
clips, ONE epoch (3,934 steps, 14 minutes), `--key24` (24-class key head trained on the 19,630 clips whose key the
generator chose; estimated and keyless clips keep the tie targets for the 12-class signature). Family splits clean; no
HumTrans contour source in humtrans-test or humtrans-tune. Decoding thresholds from humtrans-tune: onset 0.6,
activity 0.5. Copy: `/mnt/d/casperaki-data/hum-pitch/runs/bigru128-humnotes-r123-20261123-2136/`. Tables:
[model-bigru128-humnotes-r123-20261123-2136.md](model-bigru128-humnotes-r123-20261123-2136.md),
[combine-bigru128-humnotes-r123-20261123-2136.md](combine-bigru128-humnotes-r123-20261123-2136.md).

| HumTrans test | right note | precision | F | semitone | missed | key = signature | key fits best |
|---|---|---|---|---|---|---|---|
| previous best: run two + step-1 pitching, model key | 78.3% | 78.0% | 0.781 | 8.9% | 9.1% | 42.6% | 78.4% |
| run three alone | 78.1% | 76.4% | 0.773 | 11.6% | 7.9% | 45.3% | 79.4% |
| **run three + step-1 pitching, model key** | **79.8%** | **78.0%** | **0.789** | 8.6% | 7.9% | 45.3% | 79.4% |
| women: alone / combination | 88.7% / **91.2%** | 88.0% / 90.5% | 0.884 / 0.909 | 6.0% / 3.2% | 4.8% | 57.2% | 89.9% |
| men: alone / combination | 69.1% / **70.0%** | 66.8% / 67.7% | 0.680 / 0.688 | 16.5% / 13.2% | 10.5% | 34.8% | 70.3% |

Synthetic test (500): alone 77.9% (combination 73.5%). r3-test (979): alone 54.1% (today's step-1 best 40.8%;
combination 50.5%), semitone errors 28%. r3-test-unseen (385): alone 54.7% (step 1: 41.4%); the strictly unseen SoulX
yue_target voice (173): alone 49.6% (step 1: 36.4%; combination 47.3%).

24-class key (tonic + major/minor), argmax of the key head: synthetic test exact keys 19.9% of 136, estimated keys
34.2% of 114; r3-test exact 18.9% of 523, estimated 26.3% of 456; r3-test-unseen exact 20.1%, estimated 22.8%;
round-three-plus dev (exact only) 20.9%. Chance is 4%. Weak: the generator's own keys often are modes (dorian,
phrygian, lydian ...) whose tonic the melody does not make clear, and one epoch with a small head on 19,630 keyed clips
is not enough to learn tonic and mode.

Reading: men moved from 68.0% to 70.0%, women from 90.3% to 91.2%; HumTrans overall 78.3% -> 79.8%. Round three's
male-range voices with HumTrans-men deviations help only a little; its own test is hard (28% semitone errors), i.e. the
synthetic deviations are larger than what the model can undo from the pitch curve alone.
