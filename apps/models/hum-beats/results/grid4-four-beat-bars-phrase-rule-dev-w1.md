# Grid correct with 4-beat bars (bar phase rule: downbeat+phrase, weight 1.0)

- humtrans-dev: 12 clips left out (3 beats per bar, compound metre or no beat numbers)

## humtrans-dev, labelled 2 beats per bar (12 clips)

| model | correct, meant tempo, 70 ms | meant, 1/4 beat | no hint, 70 ms | no hint, 1/4 beat | wrong tempo (meant) | right tempo, wrong phase (meant, 70 ms) | of which off by 2 beats |
|---|---|---|---|---|---|---|---|
| final | 33% | 33% | 33% | 33% | 17% | 50% | 0% |
| final+dbn | 42% | 75% | 42% | 67% | 0% | 58% | 8% |
| final0 | 8% | 50% | 8% | 33% | 25% | 67% | 0% |
| final0+dbn | 25% | 50% | 17% | 33% | 8% | 67% | 0% |

## humtrans-dev, labelled 4 beats per bar (125 clips)

| model | correct, meant tempo, 70 ms | meant, 1/4 beat | no hint, 70 ms | no hint, 1/4 beat | wrong tempo (meant) | right tempo, wrong phase (meant, 70 ms) | of which off by 2 beats |
|---|---|---|---|---|---|---|---|
| final | 29% | 37% | 22% | 30% | 24% | 47% | 2% |
| final+dbn | 47% | 53% | 39% | 45% | 6% | 46% | 6% |
| final0 | 24% | 33% | 18% | 27% | 22% | 54% | 2% |
| final0+dbn | 29% | 37% | 24% | 32% | 17% | 54% | 5% |
