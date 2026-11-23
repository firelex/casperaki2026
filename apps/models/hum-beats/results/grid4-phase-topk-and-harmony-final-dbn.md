# Bar phase with 4-beat bars: final + DBN

## Top-k phase accuracy (clips with the right tempo)

| set | labelled beats per bar | clips with right tempo | correct phase ranked 1st | in top 2 | in top 3 | no phase correct |
|---|---|---|---|---|---|---|
| humtrans-test | 4 | 169 | 41% | 56% | 62% | 38% |
| humtrans-test | 2 | 95 | 79% | 83% | 84% | 16% |
| humtrans-dev | 4 | 117 | 38% | 49% | 60% | 36% |
| humtrans-dev | 2 | 12 | 42% | 50% | 50% | 50% |
| gtzan-vocals | 4 | 221 | 17% | 21% | 23% | 77% |

## Harmonic phase cue (share of right-tempo clips whose chosen phase is correct)

**transcribed notes** - dev (humtrans-dev, right-tempo clips, n=81): downbeat only 60%; bar/w0.25 60%, bar/w0.5 60%, bar/w1.0 59%, bar/w2.0 59%, bar/w4.0 54%, half/w0.25 62%, half/w0.5 63%, half/w1.0 63%, half/w2.0 63%, half/w4.0 60%. Chosen: half, weight 0.5.

- test humtrans-test 4 beats per bar: right-tempo clips 105; phase correct: downbeat only 66% -> with harmonic cue 66%; grid correct over all 195 clips: 35% -> 35%
- test humtrans-test 2 beats per bar: right-tempo clips 80; phase correct: downbeat only 94% -> with harmonic cue 94%; grid correct over all 101 clips: 74% -> 74%

**labelled notes** - dev (humtrans-dev, right-tempo clips, n=81): downbeat only 60%; bar/w0.25 62%, bar/w0.5 59%, bar/w1.0 59%, bar/w2.0 60%, bar/w4.0 54%, half/w0.25 62%, half/w0.5 63%, half/w1.0 62%, half/w2.0 63%, half/w4.0 63%. Chosen: half, weight 0.5.

- test humtrans-test 4 beats per bar: right-tempo clips 105; phase correct: downbeat only 66% -> with harmonic cue 66%; grid correct over all 195 clips: 35% -> 35%
- test humtrans-test 2 beats per bar: right-tempo clips 80; phase correct: downbeat only 94% -> with harmonic cue 94%; grid correct over all 101 clips: 74% -> 74%

