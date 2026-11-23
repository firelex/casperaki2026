# Hum-to-notes model, run two (round one + round two), 2026-11-23

Same model and recipe as run one ([notes-model.md](notes-model.md)), trained on round one (27,500) plus round two r2b
(19,793, SoulX clips included; pitch deviations taken from HumTrans TRAIN hums, accepted by the owner): 47,293 clips,
ONE epoch, 2,956 steps, 10 minutes on casdgx01 GPU 2 (`bigru128-humnotes-r12-20261123-1830`). Family splits kept (no
family shared with any dev or test set; no HumTrans contour source in humtrans-test or humtrans-tune). Round two stores
no key either, so the key head still learns from ties. Dev (r1-dev + r2b-dev): correction accuracy 77.6% -> 85.1%.
Decoding thresholds from humtrans-tune: onset 0.7, activity 0.4. Tables: [model-bigru128-humnotes-r12-20261123-1830.md](model-bigru128-humnotes-r12-20261123-1830.md),
[combine-bigru128-humnotes-r12-20261123-1830.md](combine-bigru128-humnotes-r12-20261123-1830.md).

| HumTrans test | right note | precision | F | octave | semitone | missed | key = signature | key fits best |
|---|---|---|---|---|---|---|---|---|
| step 1 (SwiftF0 + tuning + K-S snap) | 71.2% | 67.0% | 0.691 | 0.0% | 8.6% | 15.9% | 49.0% | 67.9% |
| run one + step-1 pitching, model key (previous best) | 75.0% | 73.0% | 0.740 | 0.0% | 9.3% | 11.3% | 40.2% | 77.4% |
| run two, model alone | 76.9% | 76.6% | 0.767 | 0.0% | 11.7% | 9.1% | 42.6% | 78.4% |
| **run two + step-1 pitching, model key** | **78.3%** | **78.0%** | **0.781** | 0.0% | 8.9% | 9.1% | 42.6% | 78.4% |
| women: run two alone / + step-1 pitching | 88.2% / **90.3%** | 87.9% / 90.0% | 0.880 / 0.901 | 0.1% / 0.1% | 5.9% / 3.5% | 5.3% / 5.3% | 52.9% | 91.3% |
| men: run two alone / + step-1 pitching | 67.3% / **68.0%** | 67.0% / 67.8% | 0.671 / 0.679 | 0.0% / 0.0% | 16.6% / 13.6% | 12.3% / 12.3% | 33.5% | 67.1% |

Synthetic test (500): run two alone 76.3% (run one 69.5%; voice 77.6%, breathy 73.5%, instrument 76.4%; round two
64.2%); with step-1 pitching 72.9%, so on synthetic clips the model's own pitch stays better.

Reading: round two adds about 5 points on real hums (model alone 72.2% -> 76.9%, combination 75.0% -> 78.3%), mostly
fewer semitone errors and misses. Women reach 90%; men stay at 68%, with semitone errors (14-17%) and misses (12%) as
the gap.
