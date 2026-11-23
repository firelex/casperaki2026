# Grid correct with 4-beat bars (bar phase rule: downbeat)

- gtzan-vocals: 10 clips left out (3 beats per bar, compound metre or no beat numbers)
- humtrans-dev: 12 clips left out (3 beats per bar, compound metre or no beat numbers)
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
| final | 5% | 9% | 4% | 7% | 45% | 50% | 1% |
| final+dbn | 11% | 15% | 9% | 12% | 35% | 54% | 2% |
| final0 | 6% | 12% | 5% | 9% | 45% | 48% | 2% |
| final0+dbn | 9% | 14% | 7% | 12% | 34% | 57% | 1% |

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
| final | 20% | 30% | 18% | 27% | 24% | 56% | 9% |
| final+dbn | 35% | 39% | 32% | 36% | 6% | 58% | 13% |
| final0 | 19% | 27% | 18% | 26% | 22% | 58% | 6% |
| final0+dbn | 24% | 31% | 22% | 29% | 17% | 59% | 8% |

## humtrans-test, labelled 2 beats per bar (101 clips)

| model | correct, meant tempo, 70 ms | meant, 1/4 beat | no hint, 70 ms | no hint, 1/4 beat | wrong tempo (meant) | right tempo, wrong phase (meant, 70 ms) | of which off by 2 beats |
|---|---|---|---|---|---|---|---|
| final | 45% | 56% | 42% | 52% | 28% | 28% | 3% |
| final+dbn | 74% | 83% | 69% | 75% | 6% | 20% | 1% |
| final0 | 27% | 48% | 24% | 41% | 23% | 50% | 2% |
| final0+dbn | 41% | 57% | 38% | 52% | 9% | 50% | 2% |

## humtrans-test, labelled 4 beats per bar (195 clips)

| model | correct, meant tempo, 70 ms | meant, 1/4 beat | no hint, 70 ms | no hint, 1/4 beat | wrong tempo (meant) | right tempo, wrong phase (meant, 70 ms) | of which off by 2 beats |
|---|---|---|---|---|---|---|---|
| final | 26% | 35% | 22% | 28% | 25% | 49% | 11% |
| final+dbn | 35% | 42% | 29% | 33% | 13% | 51% | 12% |
| final0 | 15% | 28% | 13% | 22% | 26% | 58% | 6% |
| final0+dbn | 21% | 33% | 18% | 28% | 18% | 62% | 10% |

## synthetic-r2-test, labelled 2 beats per bar (157 clips)

| model | correct, meant tempo, 70 ms | meant, 1/4 beat | no hint, 70 ms | no hint, 1/4 beat | wrong tempo (meant) | right tempo, wrong phase (meant, 70 ms) | of which off by 2 beats |
|---|---|---|---|---|---|---|---|
| final | 18% | 20% | 17% | 18% | 52% | 29% | 0% |
| final+dbn | 23% | 23% | 20% | 20% | 46% | 31% | 0% |
| final0 | 7% | 10% | 7% | 10% | 70% | 23% | 1% |
| final0+dbn | 11% | 12% | 10% | 10% | 60% | 29% | 0% |

## synthetic-r2-test, labelled 4 beats per bar (537 clips)

| model | correct, meant tempo, 70 ms | meant, 1/4 beat | no hint, 70 ms | no hint, 1/4 beat | wrong tempo (meant) | right tempo, wrong phase (meant, 70 ms) | of which off by 2 beats |
|---|---|---|---|---|---|---|---|
| final | 14% | 16% | 12% | 14% | 43% | 42% | 11% |
| final+dbn | 19% | 22% | 17% | 18% | 34% | 47% | 13% |
| final0 | 6% | 7% | 5% | 7% | 57% | 37% | 5% |
| final0+dbn | 7% | 9% | 6% | 8% | 50% | 43% | 7% |
