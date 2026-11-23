# Scores (same files for every model)

Beat and downbeat F-measure: mir_eval, 70 ms window, mean over clips, nothing trimmed. Tempo ok: the median predicted beat interval is within 4% of the labelled one (hum-lab: of the meant tempo); half/double: within 4% of half or double.


## dev-humtrans

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F round1 | downbeat F round1 | tempo ok round1 | half/double round1 |
|---|---|---|---|---|---|---|---|---|---|
| all | 149 | 0.558 | 0.324 | 56% | 1%/24% | 0.502 | 0.213 | 52% | 3%/13% |

### dev-humtrans by tempo_band

| tempo_band | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F round1 | downbeat F round1 | tempo ok round1 | half/double round1 |
|---|---|---|---|---|---|---|---|---|---|
| 120-150 | 9 | 0.635 | 0.400 | 89% | 0%/0% | 0.603 | 0.422 | 33% | 33%/0% |
| 150-200 | 5 | 0.828 | 0.574 | 80% | 20%/0% | 0.684 | 0.257 | 60% | 20%/0% |
| 60-90 | 67 | 0.493 | 0.251 | 51% | 0%/31% | 0.424 | 0.157 | 43% | 0%/27% |
| 90-120 | 68 | 0.591 | 0.367 | 54% | 0%/22% | 0.553 | 0.238 | 62% | 1%/3% |

### dev-humtrans by singer

| singer | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F round1 | downbeat F round1 | tempo ok round1 | half/double round1 |
|---|---|---|---|---|---|---|---|---|---|
| F01 | 11 | 0.451 | 0.189 | 45% | 0%/45% | 0.460 | 0.173 | 36% | 0%/27% |
| F02 | 17 | 0.503 | 0.324 | 41% | 0%/35% | 0.517 | 0.266 | 59% | 12%/18% |
| F03 | 12 | 0.486 | 0.142 | 33% | 0%/25% | 0.463 | 0.128 | 50% | 0%/8% |
| F04 | 12 | 0.600 | 0.333 | 50% | 8%/33% | 0.548 | 0.220 | 58% | 8%/17% |
| F05 | 19 | 0.655 | 0.423 | 63% | 0%/21% | 0.561 | 0.246 | 53% | 5%/21% |
| M01 | 13 | 0.600 | 0.368 | 62% | 0%/15% | 0.537 | 0.247 | 46% | 0%/8% |
| M02 | 13 | 0.438 | 0.267 | 77% | 0%/8% | 0.317 | 0.147 | 46% | 0%/0% |
| M03 | 19 | 0.609 | 0.371 | 68% | 0%/16% | 0.534 | 0.238 | 32% | 0%/11% |
| M04 | 20 | 0.535 | 0.344 | 70% | 0%/15% | 0.494 | 0.202 | 75% | 5%/5% |
| M05 | 13 | 0.644 | 0.366 | 31% | 0%/38% | 0.544 | 0.218 | 54% | 0%/23% |

## gtzan-mix-dev

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F round1 | downbeat F round1 | tempo ok round1 | half/double round1 |
|---|---|---|---|---|---|---|---|---|---|
| all | 498 | 0.888 | 0.794 | 82% | 6%/6% | 0.798 | 0.566 | 63% | 15%/9% |

### gtzan-mix-dev by genre

| genre | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F round1 | downbeat F round1 | tempo ok round1 | half/double round1 |
|---|---|---|---|---|---|---|---|---|---|
| blues | 50 | 0.806 | 0.672 | 66% | 2%/12% | 0.802 | 0.500 | 60% | 4%/14% |
| classical | 50 | 0.665 | 0.524 | 62% | 8%/10% | 0.621 | 0.382 | 52% | 14%/4% |
| country | 50 | 0.929 | 0.916 | 84% | 14%/0% | 0.849 | 0.672 | 60% | 32%/6% |
| disco | 50 | 0.985 | 0.945 | 96% | 2%/0% | 0.958 | 0.716 | 90% | 6%/2% |
| hiphop | 50 | 0.964 | 0.881 | 94% | 0%/2% | 0.797 | 0.538 | 70% | 0%/20% |
| jazz | 49 | 0.860 | 0.786 | 78% | 6%/8% | 0.763 | 0.494 | 55% | 14%/8% |
| metal | 50 | 0.877 | 0.761 | 80% | 4%/12% | 0.717 | 0.489 | 48% | 20%/6% |
| pop | 50 | 0.980 | 0.968 | 96% | 0%/4% | 0.889 | 0.665 | 84% | 2%/8% |
| reggae | 49 | 0.892 | 0.652 | 71% | 27%/2% | 0.790 | 0.641 | 41% | 53%/4% |
| rock | 50 | 0.921 | 0.831 | 88% | 2%/6% | 0.789 | 0.555 | 68% | 10%/16% |

## gtzan-vocals-dev

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F round1 | downbeat F round1 | tempo ok round1 | half/double round1 |
|---|---|---|---|---|---|---|---|---|---|
| all | 358 | 0.359 | 0.240 | 38% | 11%/7% | 0.498 | 0.221 | 37% | 8%/8% |

### gtzan-vocals-dev by genre

| genre | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F round1 | downbeat F round1 | tempo ok round1 | half/double round1 |
|---|---|---|---|---|---|---|---|---|---|
| blues | 41 | 0.212 | 0.121 | 15% | 7%/2% | 0.427 | 0.147 | 20% | 7%/5% |
| classical | 4 | 0.234 | 0.135 | 50% | 0%/0% | 0.220 | 0.094 | 0% | 0%/0% |
| country | 47 | 0.306 | 0.230 | 34% | 21%/2% | 0.450 | 0.209 | 30% | 9%/4% |
| disco | 42 | 0.569 | 0.439 | 71% | 7%/2% | 0.642 | 0.312 | 69% | 7%/0% |
| hiphop | 47 | 0.347 | 0.132 | 49% | 2%/11% | 0.536 | 0.218 | 32% | 4%/13% |
| jazz | 11 | 0.308 | 0.203 | 18% | 0%/0% | 0.273 | 0.121 | 0% | 0%/18% |
| metal | 30 | 0.217 | 0.192 | 13% | 23%/3% | 0.482 | 0.222 | 37% | 13%/3% |
| pop | 49 | 0.512 | 0.347 | 63% | 0%/16% | 0.555 | 0.235 | 37% | 2%/18% |
| reggae | 40 | 0.295 | 0.186 | 12% | 30%/5% | 0.459 | 0.203 | 28% | 10%/2% |
| rock | 47 | 0.372 | 0.265 | 36% | 9%/13% | 0.500 | 0.253 | 53% | 13%/9% |
