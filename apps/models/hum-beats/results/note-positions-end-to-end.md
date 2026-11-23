# End-to-end note positions, HumTrans test, 4-beat bars (whole-bar shift allowed)


## snapped to 16ths, labelled 4 beats per bar (195 clips)

| model | condition | note position | position + pitch | clips >= 90% positions | clips with every bar-1 note right |
|---|---|---|---|---|---|
| - | transcribed on labelled beats | 78% | 67% | 26% | 29% |
| final | labelled notes on predicted beats [activation] | 71% | 50% | 39% | 54% |
| final | labelled notes on predicted beats [dbn4] | 71% | 51% | 38% | 53% |
| final | transcribed on predicted beats [activation] | 68% | 41% | 28% | 46% |
| final | transcribed on predicted beats [dbn4] | 69% | 42% | 27% | 46% |
| final0 | labelled notes on predicted beats [activation] | 61% | 39% | 22% | 34% |
| final0 | labelled notes on predicted beats [dbn4] | 62% | 39% | 22% | 35% |
| final0 | transcribed on predicted beats [activation] | 63% | 34% | 23% | 44% |
| final0 | transcribed on predicted beats [dbn4] | 63% | 34% | 23% | 45% |

## snapped to 16ths, labelled 2 beats per bar (101 clips)

| model | condition | note position | position + pitch | clips >= 90% positions | clips with every bar-1 note right |
|---|---|---|---|---|---|
| - | transcribed on labelled beats | 73% | 59% | 18% | 15% |
| final | labelled notes on predicted beats [activation] | 91% | 84% | 73% | 68% |
| final | labelled notes on predicted beats [dbn4] | 91% | 83% | 72% | 66% |
| final | transcribed on predicted beats [activation] | 86% | 66% | 53% | 51% |
| final | transcribed on predicted beats [dbn4] | 86% | 66% | 54% | 52% |
| final0 | labelled notes on predicted beats [activation] | 78% | 62% | 39% | 37% |
| final0 | labelled notes on predicted beats [dbn4] | 78% | 63% | 40% | 36% |
| final0 | transcribed on predicted beats [activation] | 81% | 54% | 43% | 54% |
| final0 | transcribed on predicted beats [dbn4] | 81% | 55% | 44% | 53% |

## snapped to 8ths, labelled 4 beats per bar (195 clips)

| model | condition | note position | position + pitch | clips >= 90% positions | clips with every bar-1 note right |
|---|---|---|---|---|---|
| - | transcribed on labelled beats | 89% | 77% | 53% | 71% |
| final | labelled notes on predicted beats [activation] | 75% | 52% | 36% | 63% |
| final | labelled notes on predicted beats [dbn4] | 75% | 53% | 36% | 64% |
| final | transcribed on predicted beats [activation] | 73% | 44% | 26% | 59% |
| final | transcribed on predicted beats [dbn4] | 73% | 45% | 26% | 59% |
| final0 | labelled notes on predicted beats [activation] | 69% | 44% | 26% | 55% |
| final0 | labelled notes on predicted beats [dbn4] | 70% | 44% | 26% | 57% |
| final0 | transcribed on predicted beats [activation] | 68% | 37% | 19% | 57% |
| final0 | transcribed on predicted beats [dbn4] | 69% | 37% | 19% | 59% |

## snapped to 8ths, labelled 2 beats per bar (101 clips)

| model | condition | note position | position + pitch | clips >= 90% positions | clips with every bar-1 note right |
|---|---|---|---|---|---|
| - | transcribed on labelled beats | 92% | 77% | 72% | 68% |
| final | labelled notes on predicted beats [activation] | 91% | 84% | 71% | 85% |
| final | labelled notes on predicted beats [dbn4] | 91% | 83% | 70% | 85% |
| final | transcribed on predicted beats [activation] | 88% | 68% | 57% | 73% |
| final | transcribed on predicted beats [dbn4] | 88% | 68% | 56% | 74% |
| final0 | labelled notes on predicted beats [activation] | 84% | 66% | 47% | 69% |
| final0 | labelled notes on predicted beats [dbn4] | 85% | 68% | 48% | 68% |
| final0 | transcribed on predicted beats [activation] | 83% | 56% | 41% | 66% |
| final0 | transcribed on predicted beats [dbn4] | 83% | 57% | 42% | 67% |
