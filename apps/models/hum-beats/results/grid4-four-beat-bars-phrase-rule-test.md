# Grid correct with 4-beat bars (bar phase rule: downbeat+phrase, weight 1.0)

- gtzan-vocals: 10 clips left out (3 beats per bar, compound metre or no beat numbers)
- synthetic-r2-test: 296 clips left out (3 beats per bar, compound metre or no beat numbers)

## gtzan-vocals, labelled 2 beats per bar (1 clips)

| model | correct, meant tempo, 70 ms | meant, 1/4 beat | no hint, 70 ms | no hint, 1/4 beat | wrong tempo (meant) | right tempo, wrong phase (meant, 70 ms) | of which off by 2 beats |
|---|---|---|---|---|---|---|---|
| final | 0% | 0% | 0% | 0% | 100% | 0% | 0% |
| final+dbn | 0% | 0% | 0% | 0% | 100% | 0% | 0% |
| final0 | 0% | 0% | 0% | 0% | 100% | 0% | 0% |
| final0+dbn | 0% | 0% | 0% | 0% | 100% | 0% | 0% |

## gtzan-vocals, labelled 4 beats per bar (339 clips)

| model | correct, meant tempo, 70 ms | meant, 1/4 beat | no hint, 70 ms | no hint, 1/4 beat | wrong tempo (meant) | right tempo, wrong phase (meant, 70 ms) | of which off by 2 beats |
|---|---|---|---|---|---|---|---|
| final | 5% | 7% | 4% | 6% | 45% | 50% | 1% |
| final+dbn | 9% | 13% | 7% | 10% | 35% | 57% | 3% |
| final0 | 6% | 11% | 4% | 9% | 45% | 49% | 2% |
| final0+dbn | 8% | 13% | 6% | 11% | 34% | 58% | 3% |

## humtrans-test, labelled 2 beats per bar (101 clips)

| model | correct, meant tempo, 70 ms | meant, 1/4 beat | no hint, 70 ms | no hint, 1/4 beat | wrong tempo (meant) | right tempo, wrong phase (meant, 70 ms) | of which off by 2 beats |
|---|---|---|---|---|---|---|---|
| final | 45% | 56% | 42% | 52% | 28% | 28% | 3% |
| final+dbn | 75% | 84% | 70% | 76% | 6% | 19% | 1% |
| final0 | 28% | 50% | 25% | 42% | 23% | 50% | 2% |
| final0+dbn | 43% | 60% | 39% | 53% | 9% | 49% | 2% |

## humtrans-test, labelled 4 beats per bar (195 clips)

| model | correct, meant tempo, 70 ms | meant, 1/4 beat | no hint, 70 ms | no hint, 1/4 beat | wrong tempo (meant) | right tempo, wrong phase (meant, 70 ms) | of which off by 2 beats |
|---|---|---|---|---|---|---|---|
| final | 29% | 40% | 25% | 32% | 25% | 46% | 7% |
| final+dbn | 37% | 44% | 31% | 35% | 13% | 49% | 9% |
| final0 | 16% | 31% | 14% | 25% | 26% | 57% | 7% |
| final0+dbn | 23% | 37% | 21% | 32% | 18% | 59% | 9% |

## synthetic-r2-test, labelled 2 beats per bar (157 clips)

| model | correct, meant tempo, 70 ms | meant, 1/4 beat | no hint, 70 ms | no hint, 1/4 beat | wrong tempo (meant) | right tempo, wrong phase (meant, 70 ms) | of which off by 2 beats |
|---|---|---|---|---|---|---|---|
| final | 16% | 18% | 14% | 15% | 52% | 32% | 0% |
| final+dbn | 21% | 21% | 18% | 18% | 46% | 32% | 0% |
| final0 | 9% | 11% | 9% | 11% | 70% | 21% | 1% |
| final0+dbn | 13% | 13% | 11% | 12% | 60% | 27% | 0% |

## synthetic-r2-test, labelled 4 beats per bar (537 clips)

| model | correct, meant tempo, 70 ms | meant, 1/4 beat | no hint, 70 ms | no hint, 1/4 beat | wrong tempo (meant) | right tempo, wrong phase (meant, 70 ms) | of which off by 2 beats |
|---|---|---|---|---|---|---|---|
| final | 14% | 15% | 12% | 13% | 43% | 43% | 9% |
| final+dbn | 18% | 20% | 16% | 17% | 34% | 48% | 11% |
| final0 | 6% | 7% | 5% | 6% | 57% | 37% | 4% |
| final0+dbn | 7% | 9% | 6% | 7% | 50% | 43% | 6% |
