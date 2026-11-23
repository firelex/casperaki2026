# Scores (same files for every model)

Beat and downbeat F-measure: mir_eval, 70 ms window, mean over clips, nothing trimmed. Tempo ok: the median predicted beat interval is within 4% of the labelled one (hum-lab: of the meant tempo); half/double: within 4% of half or double.


## humtrans-test

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 296 | 0.556 | 0.352 | 58% | 0%/24% | 0.531 | 0.316 | 73% | 1%/12% | 0.690 | 0.458 | 61% | 0%/18% | 0.707 | 0.464 | 84% | 0%/5% |

### humtrans-test: grid correct (one steady grid with bar lines; see scripts/score.py grid_correct)

| model | clips | grid (meant tempo, 70 ms) | grid (meant tempo, 1/4 beat) | grid (no hint, 70 ms) | grid (no hint, 1/4 beat) | tempo right, bars wrong (meant, 70 ms) | tempo right, bars wrong (no hint, 70 ms) |
|---|---|---|---|---|---|---|---|
| final0 | 296 | 7% | 14% | 6% | 12% | 68% | 57% |
| final0+dbn | 296 | 11% | 20% | 11% | 18% | 74% | 62% |
| final | 296 | 10% | 13% | 10% | 12% | 64% | 54% |
| final+dbn | 296 | 21% | 26% | 18% | 22% | 68% | 57% |

### humtrans-test by tempo_band

| tempo_band | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 120-150 | 14 | 0.594 | 0.504 | 43% | 0%/43% | 0.643 | 0.451 | 86% | 7%/0% | 0.769 | 0.580 | 36% | 0%/36% | 0.871 | 0.464 | 86% | 0%/0% |
| 60-90 | 138 | 0.548 | 0.319 | 57% | 0%/21% | 0.545 | 0.308 | 59% | 0%/23% | 0.690 | 0.382 | 62% | 0%/17% | 0.713 | 0.425 | 80% | 0%/8% |
| 90-120 | 144 | 0.559 | 0.370 | 62% | 0%/24% | 0.507 | 0.311 | 85% | 1%/3% | 0.682 | 0.518 | 64% | 0%/17% | 0.686 | 0.502 | 87% | 1%/2% |

### humtrans-test by singer

| singer | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| F01 | 43 | 0.589 | 0.430 | 56% | 0%/21% | 0.548 | 0.326 | 74% | 0%/9% | 0.699 | 0.504 | 65% | 0%/19% | 0.694 | 0.483 | 88% | 0%/5% |
| F02 | 28 | 0.517 | 0.275 | 50% | 0%/29% | 0.530 | 0.276 | 68% | 0%/21% | 0.628 | 0.378 | 50% | 0%/25% | 0.632 | 0.422 | 93% | 0%/0% |
| F03 | 22 | 0.600 | 0.212 | 41% | 0%/41% | 0.608 | 0.288 | 68% | 0%/9% | 0.739 | 0.477 | 73% | 0%/5% | 0.768 | 0.531 | 82% | 0%/0% |
| F04 | 30 | 0.617 | 0.250 | 40% | 0%/57% | 0.487 | 0.152 | 67% | 0%/30% | 0.823 | 0.488 | 73% | 0%/17% | 0.858 | 0.383 | 90% | 0%/10% |
| F05 | 15 | 0.663 | 0.533 | 73% | 0%/20% | 0.624 | 0.595 | 80% | 0%/7% | 0.743 | 0.521 | 80% | 0%/7% | 0.745 | 0.581 | 73% | 0%/7% |
| M01 | 39 | 0.612 | 0.429 | 74% | 0%/15% | 0.619 | 0.410 | 77% | 0%/10% | 0.712 | 0.498 | 56% | 0%/36% | 0.714 | 0.522 | 92% | 0%/5% |
| M02 | 31 | 0.430 | 0.292 | 58% | 0%/10% | 0.390 | 0.239 | 77% | 3%/6% | 0.578 | 0.372 | 55% | 0%/6% | 0.591 | 0.432 | 74% | 3%/0% |
| M03 | 24 | 0.522 | 0.353 | 50% | 0%/21% | 0.513 | 0.305 | 58% | 4%/8% | 0.640 | 0.363 | 50% | 0%/12% | 0.649 | 0.424 | 58% | 0%/8% |
| M04 | 48 | 0.488 | 0.334 | 75% | 0%/10% | 0.471 | 0.326 | 83% | 0%/6% | 0.673 | 0.478 | 69% | 0%/12% | 0.717 | 0.482 | 88% | 0%/4% |
| M05 | 16 | 0.615 | 0.478 | 50% | 0%/31% | 0.643 | 0.349 | 62% | 0%/19% | 0.692 | 0.478 | 38% | 0%/38% | 0.737 | 0.363 | 81% | 0%/12% |

## singing-gtzan-vocals

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 350 | 0.335 | 0.222 | 39% | 11%/3% | 0.417 | 0.251 | 46% | 17%/2% | 0.454 | 0.248 | 39% | 7%/9% | 0.428 | 0.229 | 42% | 19%/1% |

### singing-gtzan-vocals: grid correct (one steady grid with bar lines; see scripts/score.py grid_correct)

| model | clips | grid (meant tempo, 70 ms) | grid (meant tempo, 1/4 beat) | grid (no hint, 70 ms) | grid (no hint, 1/4 beat) | tempo right, bars wrong (meant, 70 ms) | tempo right, bars wrong (no hint, 70 ms) |
|---|---|---|---|---|---|---|---|
| final0 | 350 | 1% | 3% | 1% | 2% | 53% | 41% |
| final0+dbn | 350 | 5% | 9% | 5% | 9% | 59% | 47% |
| final | 350 | 1% | 1% | 1% | 1% | 53% | 41% |
| final+dbn | 350 | 6% | 9% | 6% | 9% | 57% | 42% |

### singing-gtzan-vocals by genre

| genre | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| blues | 37 | 0.147 | 0.092 | 16% | 16%/0% | 0.247 | 0.104 | 16% | 22%/0% | 0.317 | 0.154 | 27% | 0%/5% | 0.280 | 0.089 | 16% | 16%/0% |
| classical | 2 | 0.052 | 0.000 | 0% | 0%/0% | 0.185 | 0.000 | 0% | 0%/0% | 0.094 | 0.040 | 0% | 0%/0% | 0.121 | 0.067 | 0% | 0%/0% |
| country | 48 | 0.343 | 0.252 | 35% | 12%/2% | 0.421 | 0.293 | 42% | 23%/4% | 0.429 | 0.258 | 38% | 12%/8% | 0.398 | 0.253 | 31% | 27%/2% |
| disco | 41 | 0.500 | 0.372 | 68% | 7%/0% | 0.550 | 0.391 | 61% | 15%/0% | 0.567 | 0.345 | 59% | 5%/5% | 0.544 | 0.331 | 59% | 20%/0% |
| hiphop | 45 | 0.290 | 0.158 | 40% | 2%/7% | 0.391 | 0.195 | 53% | 2%/0% | 0.537 | 0.269 | 29% | 0%/22% | 0.527 | 0.301 | 62% | 2%/0% |
| jazz | 17 | 0.210 | 0.155 | 24% | 0%/0% | 0.243 | 0.122 | 24% | 0%/6% | 0.220 | 0.121 | 29% | 0%/6% | 0.196 | 0.053 | 18% | 0%/0% |
| metal | 33 | 0.260 | 0.184 | 30% | 24%/3% | 0.407 | 0.251 | 42% | 30%/3% | 0.404 | 0.246 | 42% | 15%/9% | 0.376 | 0.255 | 27% | 42%/3% |
| pop | 48 | 0.451 | 0.295 | 60% | 4%/8% | 0.509 | 0.336 | 77% | 4%/6% | 0.508 | 0.250 | 48% | 2%/10% | 0.471 | 0.268 | 73% | 2%/6% |
| reggae | 38 | 0.296 | 0.239 | 13% | 32%/3% | 0.383 | 0.264 | 16% | 45%/3% | 0.478 | 0.279 | 32% | 26%/3% | 0.487 | 0.240 | 24% | 45%/0% |
| rock | 41 | 0.407 | 0.191 | 49% | 5%/2% | 0.476 | 0.206 | 61% | 12%/0% | 0.472 | 0.230 | 46% | 0%/5% | 0.419 | 0.147 | 46% | 20%/0% |

## music-gtzan-mix

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 500 | 0.887 | 0.771 | 83% | 4%/5% | 0.876 | 0.757 | 84% | 6%/3% | 0.862 | 0.728 | 79% | 11%/4% | 0.852 | 0.721 | 78% | 15%/2% |

### music-gtzan-mix: grid correct (one steady grid with bar lines; see scripts/score.py grid_correct)

| model | clips | grid (meant tempo, 70 ms) | grid (meant tempo, 1/4 beat) | grid (no hint, 70 ms) | grid (no hint, 1/4 beat) | tempo right, bars wrong (meant, 70 ms) | tempo right, bars wrong (no hint, 70 ms) |
|---|---|---|---|---|---|---|---|
| final0 | 500 | 31% | 35% | 28% | 31% | 61% | 37% |
| final0+dbn | 500 | 34% | 39% | 30% | 34% | 59% | 36% |
| final | 500 | 29% | 32% | 26% | 28% | 64% | 40% |
| final+dbn | 500 | 32% | 37% | 30% | 34% | 62% | 37% |

### music-gtzan-mix by genre

| genre | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| blues | 50 | 0.854 | 0.607 | 74% | 6%/10% | 0.828 | 0.577 | 82% | 8%/2% | 0.854 | 0.575 | 80% | 8%/8% | 0.858 | 0.553 | 88% | 10%/0% |
| classical | 50 | 0.638 | 0.491 | 52% | 8%/6% | 0.654 | 0.480 | 64% | 8%/4% | 0.614 | 0.401 | 62% | 8%/6% | 0.609 | 0.426 | 66% | 14%/2% |
| country | 50 | 0.951 | 0.894 | 92% | 2%/2% | 0.951 | 0.902 | 92% | 2%/2% | 0.911 | 0.869 | 80% | 12%/4% | 0.915 | 0.865 | 82% | 10%/4% |
| disco | 50 | 0.944 | 0.923 | 94% | 2%/0% | 0.944 | 0.921 | 94% | 2%/0% | 0.956 | 0.916 | 94% | 2%/0% | 0.954 | 0.923 | 94% | 2%/0% |
| hiphop | 50 | 0.979 | 0.911 | 96% | 0%/4% | 0.992 | 0.894 | 100% | 0%/0% | 0.978 | 0.919 | 98% | 2%/0% | 0.978 | 0.923 | 98% | 2%/0% |
| jazz | 50 | 0.872 | 0.699 | 74% | 2%/14% | 0.807 | 0.660 | 70% | 6%/6% | 0.823 | 0.579 | 74% | 8%/6% | 0.763 | 0.565 | 64% | 24%/2% |
| metal | 50 | 0.873 | 0.771 | 84% | 0%/10% | 0.845 | 0.765 | 78% | 8%/10% | 0.849 | 0.762 | 74% | 12%/6% | 0.816 | 0.745 | 66% | 28%/6% |
| pop | 50 | 0.923 | 0.909 | 88% | 2%/6% | 0.925 | 0.897 | 88% | 2%/6% | 0.915 | 0.861 | 86% | 2%/6% | 0.907 | 0.859 | 86% | 2%/8% |
| reggae | 50 | 0.918 | 0.710 | 80% | 18%/0% | 0.916 | 0.674 | 78% | 20%/0% | 0.819 | 0.596 | 50% | 48%/0% | 0.817 | 0.555 | 50% | 48%/0% |
| rock | 50 | 0.921 | 0.797 | 92% | 4%/2% | 0.896 | 0.796 | 94% | 6%/0% | 0.903 | 0.800 | 90% | 8%/0% | 0.901 | 0.785 | 90% | 6%/2% |

## synthetic-r2-test

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 990 | 0.316 | 0.142 | 25% | 2%/10% | 0.346 | 0.120 | 33% | 5%/8% | 0.508 | 0.276 | 40% | 3%/13% | 0.458 | 0.210 | 49% | 7%/5% |

### synthetic-r2-test: grid correct (one steady grid with bar lines; see scripts/score.py grid_correct)

| model | clips | grid (meant tempo, 70 ms) | grid (meant tempo, 1/4 beat) | grid (no hint, 70 ms) | grid (no hint, 1/4 beat) | tempo right, bars wrong (meant, 70 ms) | tempo right, bars wrong (no hint, 70 ms) |
|---|---|---|---|---|---|---|---|
| final0 | 990 | 1% | 2% | 1% | 1% | 36% | 31% |
| final0+dbn | 990 | 3% | 4% | 3% | 4% | 43% | 35% |
| final | 990 | 3% | 3% | 2% | 2% | 51% | 42% |
| final+dbn | 990 | 11% | 12% | 10% | 10% | 50% | 40% |

### synthetic-r2-test by lead

| lead | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| breathy | 66 | 0.136 | 0.075 | 6% | 6%/3% | 0.244 | 0.087 | 12% | 9%/6% | 0.483 | 0.248 | 29% | 3%/14% | 0.466 | 0.197 | 45% | 5%/5% |
| instrument | 226 | 0.400 | 0.182 | 27% | 0%/16% | 0.391 | 0.129 | 37% | 3%/13% | 0.504 | 0.285 | 40% | 3%/12% | 0.432 | 0.203 | 49% | 7%/5% |
| voice | 698 | 0.306 | 0.135 | 26% | 2%/9% | 0.340 | 0.120 | 34% | 5%/7% | 0.512 | 0.275 | 41% | 2%/14% | 0.466 | 0.213 | 50% | 7%/5% |

### synthetic-r2-test by lead_group

| lead_group | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bass | 46 | 0.412 | 0.209 | 28% | 0%/17% | 0.396 | 0.150 | 30% | 2%/15% | 0.501 | 0.309 | 39% | 7%/9% | 0.444 | 0.257 | 50% | 13%/7% |
| breathy | 66 | 0.136 | 0.075 | 6% | 6%/3% | 0.244 | 0.087 | 12% | 9%/6% | 0.483 | 0.248 | 29% | 3%/14% | 0.466 | 0.197 | 45% | 5%/5% |
| guitar | 40 | 0.484 | 0.226 | 35% | 2%/15% | 0.429 | 0.135 | 50% | 8%/8% | 0.557 | 0.334 | 48% | 5%/12% | 0.454 | 0.216 | 55% | 5%/5% |
| keys | 48 | 0.425 | 0.191 | 25% | 0%/15% | 0.449 | 0.138 | 38% | 2%/21% | 0.516 | 0.265 | 40% | 0%/15% | 0.427 | 0.180 | 46% | 6%/4% |
| soulx | 386 | 0.313 | 0.131 | 27% | 2%/10% | 0.355 | 0.126 | 38% | 4%/7% | 0.507 | 0.272 | 38% | 2%/16% | 0.461 | 0.198 | 50% | 6%/6% |
| strings_brass | 44 | 0.308 | 0.118 | 30% | 0%/18% | 0.337 | 0.119 | 41% | 0%/9% | 0.525 | 0.268 | 45% | 2%/9% | 0.459 | 0.196 | 55% | 7%/5% |
| synth | 48 | 0.379 | 0.171 | 19% | 0%/17% | 0.349 | 0.104 | 29% | 2%/12% | 0.431 | 0.258 | 29% | 2%/15% | 0.384 | 0.169 | 40% | 4%/6% |
| vocal_sample | 28 | 0.343 | 0.140 | 25% | 0%/11% | 0.351 | 0.086 | 25% | 7%/11% | 0.556 | 0.279 | 39% | 4%/18% | 0.560 | 0.286 | 43% | 7%/11% |
| voice | 284 | 0.292 | 0.141 | 23% | 1%/7% | 0.319 | 0.116 | 29% | 6%/7% | 0.515 | 0.279 | 45% | 2%/10% | 0.463 | 0.227 | 51% | 9%/2% |

### synthetic-r2-test by timing

| timing | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| perfect | 113 | 0.381 | 0.204 | 27% | 3%/19% | 0.417 | 0.152 | 42% | 7%/13% | 0.538 | 0.310 | 40% | 3%/25% | 0.539 | 0.249 | 57% | 10%/9% |
| real | 877 | 0.307 | 0.134 | 24% | 2%/9% | 0.337 | 0.116 | 32% | 5%/8% | 0.504 | 0.271 | 40% | 3%/12% | 0.448 | 0.204 | 48% | 7%/4% |

### synthetic-r2-test by meter

| meter | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2/4 | 157 | 0.283 | 0.172 | 18% | 2%/11% | 0.310 | 0.130 | 27% | 3%/10% | 0.441 | 0.283 | 33% | 1%/15% | 0.404 | 0.198 | 43% | 4%/5% |
| 3/4 | 208 | 0.321 | 0.129 | 26% | 1%/10% | 0.383 | 0.121 | 36% | 5%/9% | 0.556 | 0.262 | 43% | 2%/16% | 0.483 | 0.140 | 48% | 9%/7% |
| 4/4 | 537 | 0.329 | 0.131 | 27% | 2%/12% | 0.347 | 0.113 | 36% | 6%/9% | 0.518 | 0.265 | 42% | 3%/13% | 0.473 | 0.238 | 55% | 7%/5% |
| 6/8 | 88 | 0.280 | 0.191 | 17% | 2%/2% | 0.312 | 0.143 | 22% | 2%/1% | 0.458 | 0.361 | 31% | 1%/1% | 0.406 | 0.222 | 31% | 8%/0% |

### synthetic-r2-test by tempo_band

| tempo_band | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 120-150 | 121 | 0.287 | 0.119 | 23% | 3%/1% | 0.335 | 0.109 | 24% | 20%/0% | 0.484 | 0.289 | 42% | 7%/1% | 0.432 | 0.187 | 31% | 27%/0% |
| 150-200 | 103 | 0.190 | 0.074 | 8% | 6%/0% | 0.266 | 0.041 | 7% | 14%/0% | 0.411 | 0.208 | 16% | 15%/0% | 0.328 | 0.113 | 11% | 26%/0% |
| 60-90 | 356 | 0.358 | 0.177 | 25% | 1%/19% | 0.380 | 0.161 | 32% | 0%/22% | 0.538 | 0.291 | 40% | 0%/24% | 0.508 | 0.251 | 58% | 0%/13% |
| 90-120 | 410 | 0.319 | 0.136 | 29% | 1%/8% | 0.339 | 0.107 | 43% | 2%/1% | 0.514 | 0.275 | 45% | 0%/11% | 0.455 | 0.204 | 57% | 3%/0% |

### synthetic-r2-test by pollution

| pollution | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| heavy | 242 | 0.237 | 0.099 | 17% | 1%/12% | 0.296 | 0.108 | 23% | 5%/11% | 0.475 | 0.263 | 36% | 2%/17% | 0.436 | 0.224 | 49% | 4%/9% |
| light | 293 | 0.344 | 0.159 | 26% | 3%/8% | 0.361 | 0.124 | 35% | 5%/8% | 0.526 | 0.287 | 42% | 2%/12% | 0.466 | 0.221 | 47% | 8%/3% |
| medium | 323 | 0.325 | 0.154 | 27% | 1%/11% | 0.356 | 0.125 | 36% | 6%/9% | 0.511 | 0.275 | 41% | 3%/14% | 0.459 | 0.194 | 51% | 9%/5% |
| none | 132 | 0.375 | 0.156 | 30% | 2%/9% | 0.377 | 0.124 | 42% | 3%/4% | 0.522 | 0.278 | 39% | 2%/8% | 0.477 | 0.197 | 51% | 7%/1% |

### synthetic-r2-test by style

| style | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| straight | 588 | 0.328 | 0.153 | 25% | 2%/12% | 0.349 | 0.128 | 34% | 5%/9% | 0.512 | 0.289 | 39% | 3%/14% | 0.457 | 0.217 | 49% | 9%/6% |
| swung | 141 | 0.348 | 0.152 | 29% | 2%/1% | 0.397 | 0.149 | 34% | 6%/4% | 0.607 | 0.320 | 56% | 2%/1% | 0.560 | 0.266 | 55% | 7%/0% |
| syncopated | 261 | 0.272 | 0.113 | 21% | 2%/10% | 0.310 | 0.088 | 30% | 3%/10% | 0.446 | 0.222 | 33% | 2%/18% | 0.405 | 0.163 | 46% | 4%/6% |

### synthetic-r2-test by start

| start | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| downbeat | 310 | 0.316 | 0.161 | 22% | 2%/11% | 0.347 | 0.128 | 32% | 5%/10% | 0.511 | 0.302 | 39% | 3%/15% | 0.465 | 0.255 | 49% | 8%/4% |
| midbar | 282 | 0.272 | 0.107 | 22% | 1%/11% | 0.301 | 0.097 | 31% | 3%/9% | 0.479 | 0.235 | 35% | 1%/14% | 0.420 | 0.167 | 49% | 6%/4% |
| pickup | 398 | 0.347 | 0.153 | 28% | 2%/10% | 0.376 | 0.130 | 36% | 6%/8% | 0.526 | 0.285 | 44% | 3%/11% | 0.480 | 0.204 | 50% | 7%/6% |

### synthetic-r2-test by bars

| bars | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2.0 | 342 | 0.286 | 0.119 | 17% | 1%/9% | 0.308 | 0.105 | 26% | 4%/8% | 0.484 | 0.262 | 30% | 3%/13% | 0.426 | 0.163 | 39% | 8%/5% |
| 4.0 | 324 | 0.331 | 0.156 | 27% | 3%/10% | 0.374 | 0.134 | 35% | 7%/8% | 0.515 | 0.271 | 44% | 3%/12% | 0.465 | 0.211 | 52% | 6%/5% |
| 8.0 | 324 | 0.333 | 0.153 | 30% | 2%/12% | 0.358 | 0.122 | 40% | 4%/9% | 0.527 | 0.295 | 47% | 2%/14% | 0.485 | 0.258 | 58% | 8%/5% |

## synthetic-r2-test-unseen

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 443 | 0.369 | 0.173 | 32% | 3%/12% | 0.378 | 0.138 | 40% | 4%/10% | 0.539 | 0.279 | 46% | 3%/12% | 0.502 | 0.206 | 59% | 7%/4% |

### synthetic-r2-test-unseen: grid correct (one steady grid with bar lines; see scripts/score.py grid_correct)

| model | clips | grid (meant tempo, 70 ms) | grid (meant tempo, 1/4 beat) | grid (no hint, 70 ms) | grid (no hint, 1/4 beat) | tempo right, bars wrong (meant, 70 ms) | tempo right, bars wrong (no hint, 70 ms) |
|---|---|---|---|---|---|---|---|
| final0 | 443 | 1% | 1% | 1% | 1% | 45% | 35% |
| final0+dbn | 443 | 5% | 5% | 5% | 5% | 47% | 35% |
| final | 443 | 1% | 2% | 1% | 1% | 60% | 45% |
| final+dbn | 443 | 10% | 11% | 9% | 10% | 60% | 46% |

### synthetic-r2-test-unseen by lead

| lead | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| breathy | 46 | 0.215 | 0.083 | 20% | 0%/13% | 0.301 | 0.140 | 28% | 4%/9% | 0.543 | 0.288 | 43% | 2%/24% | 0.500 | 0.257 | 52% | 7%/15% |
| instrument | 124 | 0.482 | 0.210 | 38% | 6%/18% | 0.452 | 0.154 | 44% | 2%/14% | 0.586 | 0.290 | 46% | 1%/13% | 0.556 | 0.230 | 62% | 6%/4% |
| voice | 273 | 0.344 | 0.171 | 31% | 2%/10% | 0.357 | 0.130 | 40% | 4%/9% | 0.517 | 0.272 | 46% | 4%/10% | 0.477 | 0.186 | 58% | 7%/3% |

### synthetic-r2-test-unseen by lead_group

| lead_group | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bass | 25 | 0.464 | 0.196 | 36% | 0%/28% | 0.435 | 0.170 | 52% | 0%/16% | 0.624 | 0.273 | 56% | 0%/16% | 0.639 | 0.298 | 84% | 0%/0% |
| breathy | 46 | 0.215 | 0.083 | 20% | 0%/13% | 0.301 | 0.140 | 28% | 4%/9% | 0.543 | 0.288 | 43% | 2%/24% | 0.500 | 0.257 | 52% | 7%/15% |
| guitar | 25 | 0.514 | 0.198 | 52% | 12%/12% | 0.482 | 0.123 | 48% | 0%/12% | 0.511 | 0.249 | 40% | 4%/12% | 0.424 | 0.150 | 48% | 16%/4% |
| keys | 25 | 0.617 | 0.309 | 40% | 8%/8% | 0.529 | 0.252 | 44% | 8%/8% | 0.679 | 0.363 | 52% | 0%/4% | 0.611 | 0.258 | 64% | 8%/4% |
| soulx | 133 | 0.386 | 0.172 | 38% | 1%/8% | 0.394 | 0.126 | 47% | 5%/6% | 0.572 | 0.278 | 46% | 3%/11% | 0.523 | 0.191 | 62% | 4%/2% |
| strings_brass | 26 | 0.380 | 0.141 | 42% | 0%/19% | 0.418 | 0.115 | 54% | 0%/12% | 0.583 | 0.303 | 38% | 0%/15% | 0.579 | 0.266 | 58% | 8%/4% |
| synth | 23 | 0.436 | 0.207 | 17% | 9%/22% | 0.392 | 0.107 | 22% | 0%/22% | 0.528 | 0.256 | 43% | 0%/17% | 0.522 | 0.174 | 57% | 0%/9% |
| voice | 140 | 0.304 | 0.171 | 25% | 3%/11% | 0.323 | 0.134 | 32% | 4%/11% | 0.464 | 0.266 | 46% | 4%/9% | 0.435 | 0.181 | 55% | 9%/3% |

### synthetic-r2-test-unseen by timing

| timing | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| perfect | 42 | 0.440 | 0.165 | 33% | 2%/14% | 0.455 | 0.169 | 50% | 5%/10% | 0.574 | 0.288 | 62% | 0%/17% | 0.562 | 0.284 | 69% | 7%/10% |
| real | 401 | 0.362 | 0.174 | 32% | 3%/12% | 0.370 | 0.134 | 39% | 3%/10% | 0.535 | 0.278 | 44% | 3%/11% | 0.495 | 0.198 | 58% | 6%/4% |

### synthetic-r2-test-unseen by meter

| meter | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2/4 | 54 | 0.369 | 0.195 | 26% | 11%/9% | 0.390 | 0.171 | 28% | 7%/6% | 0.477 | 0.338 | 44% | 4%/7% | 0.430 | 0.177 | 50% | 11%/0% |
| 3/4 | 103 | 0.432 | 0.181 | 33% | 2%/17% | 0.423 | 0.155 | 45% | 4%/14% | 0.612 | 0.277 | 50% | 1%/14% | 0.557 | 0.207 | 63% | 4%/7% |
| 4/4 | 238 | 0.359 | 0.151 | 35% | 2%/13% | 0.374 | 0.117 | 43% | 3%/11% | 0.535 | 0.256 | 47% | 3%/14% | 0.505 | 0.205 | 62% | 8%/5% |
| 6/8 | 48 | 0.286 | 0.241 | 21% | 0%/2% | 0.286 | 0.166 | 25% | 0%/2% | 0.472 | 0.330 | 33% | 2%/2% | 0.448 | 0.242 | 42% | 2%/0% |

### synthetic-r2-test-unseen by tempo_band

| tempo_band | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 120-150 | 50 | 0.331 | 0.147 | 30% | 10%/0% | 0.350 | 0.111 | 38% | 14%/0% | 0.469 | 0.225 | 50% | 6%/2% | 0.407 | 0.107 | 38% | 32%/0% |
| 150-200 | 35 | 0.255 | 0.147 | 9% | 9%/0% | 0.265 | 0.105 | 9% | 17%/0% | 0.369 | 0.255 | 14% | 26%/0% | 0.302 | 0.147 | 9% | 34%/0% |
| 60-90 | 165 | 0.409 | 0.195 | 28% | 1%/24% | 0.416 | 0.156 | 38% | 0%/25% | 0.584 | 0.298 | 48% | 0%/19% | 0.557 | 0.238 | 71% | 0%/12% |
| 90-120 | 193 | 0.366 | 0.166 | 39% | 1%/8% | 0.373 | 0.135 | 47% | 2%/2% | 0.549 | 0.280 | 48% | 0%/10% | 0.515 | 0.214 | 63% | 1%/0% |

### synthetic-r2-test-unseen by pollution

| pollution | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| heavy | 112 | 0.288 | 0.144 | 26% | 2%/16% | 0.312 | 0.134 | 34% | 1%/12% | 0.448 | 0.218 | 39% | 4%/12% | 0.411 | 0.167 | 52% | 6%/6% |
| light | 140 | 0.387 | 0.186 | 37% | 3%/12% | 0.400 | 0.163 | 44% | 5%/11% | 0.594 | 0.323 | 53% | 3%/11% | 0.558 | 0.245 | 66% | 8%/2% |
| medium | 123 | 0.383 | 0.158 | 29% | 3%/10% | 0.416 | 0.113 | 37% | 5%/9% | 0.526 | 0.261 | 41% | 1%/12% | 0.497 | 0.190 | 54% | 6%/7% |
| none | 68 | 0.440 | 0.220 | 35% | 3%/12% | 0.372 | 0.135 | 46% | 3%/7% | 0.598 | 0.320 | 49% | 3%/12% | 0.544 | 0.218 | 63% | 6%/1% |

### synthetic-r2-test-unseen by style

| style | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| straight | 294 | 0.395 | 0.187 | 33% | 2%/16% | 0.405 | 0.151 | 42% | 4%/12% | 0.564 | 0.292 | 49% | 3%/14% | 0.534 | 0.227 | 64% | 6%/4% |
| swung | 49 | 0.398 | 0.186 | 37% | 2%/2% | 0.373 | 0.085 | 45% | 0%/0% | 0.556 | 0.290 | 45% | 0%/4% | 0.517 | 0.216 | 53% | 4%/0% |
| syncopated | 100 | 0.278 | 0.127 | 27% | 6%/8% | 0.300 | 0.124 | 31% | 3%/11% | 0.458 | 0.233 | 36% | 3%/11% | 0.401 | 0.140 | 46% | 8%/6% |

### synthetic-r2-test-unseen by start

| start | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| downbeat | 136 | 0.332 | 0.154 | 28% | 1%/12% | 0.334 | 0.118 | 37% | 4%/10% | 0.522 | 0.285 | 40% | 4%/15% | 0.473 | 0.222 | 56% | 7%/5% |
| midbar | 127 | 0.346 | 0.159 | 25% | 2%/18% | 0.355 | 0.131 | 35% | 5%/16% | 0.487 | 0.240 | 40% | 3%/17% | 0.457 | 0.167 | 57% | 7%/6% |
| pickup | 180 | 0.414 | 0.197 | 39% | 4%/9% | 0.427 | 0.157 | 46% | 3%/6% | 0.588 | 0.301 | 54% | 2%/7% | 0.555 | 0.221 | 62% | 6%/2% |

### synthetic-r2-test-unseen by bars

| bars | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2.0 | 143 | 0.324 | 0.150 | 24% | 2%/11% | 0.312 | 0.085 | 34% | 1%/7% | 0.494 | 0.247 | 38% | 1%/11% | 0.437 | 0.156 | 48% | 6%/3% |
| 4.0 | 144 | 0.357 | 0.158 | 33% | 3%/12% | 0.372 | 0.161 | 42% | 5%/10% | 0.553 | 0.300 | 47% | 5%/12% | 0.508 | 0.223 | 65% | 8%/3% |
| 8.0 | 156 | 0.422 | 0.208 | 38% | 3%/13% | 0.443 | 0.165 | 44% | 4%/13% | 0.567 | 0.288 | 51% | 3%/12% | 0.555 | 0.235 | 63% | 6%/6% |

## synthetic-r1-test

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 1000 | 0.324 | 0.163 | 21% | 4%/5% | 0.346 | 0.132 | 23% | 8%/4% | 0.501 | 0.260 | 32% | 7%/5% | 0.409 | 0.159 | 31% | 18%/2% |

### synthetic-r1-test: grid correct (one steady grid with bar lines; see scripts/score.py grid_correct)

| model | clips | grid (meant tempo, 70 ms) | grid (meant tempo, 1/4 beat) | grid (no hint, 70 ms) | grid (no hint, 1/4 beat) | tempo right, bars wrong (meant, 70 ms) | tempo right, bars wrong (no hint, 70 ms) |
|---|---|---|---|---|---|---|---|
| final0 | 1000 | 2% | 2% | 1% | 1% | 27% | 17% |
| final0+dbn | 1000 | 3% | 3% | 2% | 2% | 33% | 19% |
| final | 1000 | 4% | 4% | 2% | 2% | 40% | 23% |
| final+dbn | 1000 | 5% | 5% | 4% | 4% | 46% | 24% |

### synthetic-r1-test by lead

| lead | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| breathy | 128 | 0.126 | 0.069 | 6% | 2%/2% | 0.223 | 0.085 | 12% | 4%/2% | 0.464 | 0.239 | 27% | 6%/2% | 0.394 | 0.144 | 33% | 12%/1% |
| instrument | 407 | 0.423 | 0.208 | 30% | 5%/7% | 0.412 | 0.153 | 33% | 10%/4% | 0.524 | 0.262 | 37% | 5%/6% | 0.430 | 0.166 | 33% | 18%/2% |
| voice | 465 | 0.292 | 0.149 | 17% | 4%/5% | 0.322 | 0.126 | 18% | 8%/4% | 0.492 | 0.265 | 29% | 8%/5% | 0.395 | 0.157 | 28% | 20%/2% |

### synthetic-r1-test by lead_group

| lead_group | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bass | 79 | 0.392 | 0.211 | 25% | 4%/4% | 0.391 | 0.156 | 38% | 6%/1% | 0.469 | 0.240 | 24% | 5%/6% | 0.395 | 0.149 | 27% | 15%/1% |
| breathy | 128 | 0.126 | 0.069 | 6% | 2%/2% | 0.223 | 0.085 | 12% | 4%/2% | 0.464 | 0.239 | 27% | 6%/2% | 0.394 | 0.144 | 33% | 12%/1% |
| guitar | 92 | 0.424 | 0.210 | 27% | 7%/11% | 0.417 | 0.150 | 28% | 15%/8% | 0.535 | 0.264 | 38% | 7%/9% | 0.434 | 0.145 | 30% | 18%/2% |
| keys | 70 | 0.417 | 0.200 | 37% | 7%/4% | 0.390 | 0.157 | 40% | 14%/3% | 0.534 | 0.263 | 39% | 7%/6% | 0.430 | 0.165 | 39% | 17%/3% |
| strings_brass | 79 | 0.413 | 0.207 | 25% | 4%/9% | 0.421 | 0.163 | 28% | 8%/5% | 0.532 | 0.279 | 44% | 4%/4% | 0.431 | 0.209 | 35% | 20%/1% |
| synth | 87 | 0.464 | 0.210 | 37% | 3%/6% | 0.433 | 0.141 | 33% | 8%/2% | 0.544 | 0.261 | 40% | 5%/5% | 0.457 | 0.164 | 36% | 20%/1% |
| vocal_sample | 49 | 0.415 | 0.177 | 35% | 8%/10% | 0.395 | 0.136 | 35% | 12%/6% | 0.619 | 0.322 | 37% | 4%/6% | 0.509 | 0.176 | 43% | 24%/2% |
| voice | 416 | 0.278 | 0.145 | 15% | 4%/4% | 0.313 | 0.125 | 16% | 8%/4% | 0.477 | 0.258 | 29% | 9%/5% | 0.382 | 0.154 | 26% | 19%/1% |

### synthetic-r1-test by timing

| timing | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| humanised | 432 | 0.336 | 0.167 | 24% | 4%/6% | 0.360 | 0.145 | 25% | 9%/5% | 0.494 | 0.266 | 32% | 7%/6% | 0.399 | 0.151 | 29% | 21%/2% |
| irregular | 297 | 0.278 | 0.146 | 15% | 4%/4% | 0.298 | 0.114 | 18% | 8%/2% | 0.465 | 0.237 | 23% | 5%/4% | 0.360 | 0.141 | 25% | 15%/1% |
| perfect | 271 | 0.357 | 0.174 | 24% | 4%/6% | 0.376 | 0.130 | 28% | 8%/4% | 0.552 | 0.276 | 42% | 7%/4% | 0.480 | 0.190 | 39% | 18%/2% |

### synthetic-r1-test by meter

| meter | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 3/4 | 319 | 0.333 | 0.151 | 20% | 4%/9% | 0.344 | 0.119 | 23% | 10%/6% | 0.527 | 0.242 | 35% | 8%/7% | 0.431 | 0.126 | 36% | 19%/2% |
| 4/4 | 334 | 0.368 | 0.179 | 28% | 5%/7% | 0.393 | 0.163 | 31% | 11%/6% | 0.523 | 0.259 | 37% | 8%/8% | 0.453 | 0.208 | 39% | 20%/3% |
| 6/8 | 347 | 0.274 | 0.157 | 16% | 3%/0% | 0.302 | 0.113 | 17% | 5%/0% | 0.456 | 0.278 | 26% | 5%/1% | 0.347 | 0.141 | 18% | 16%/0% |

### synthetic-r1-test by tempo_band

| tempo_band | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 120-150 | 223 | 0.352 | 0.161 | 27% | 3%/2% | 0.368 | 0.139 | 28% | 13%/0% | 0.495 | 0.242 | 39% | 8%/3% | 0.403 | 0.144 | 30% | 24%/0% |
| 150-200 | 330 | 0.240 | 0.130 | 11% | 10%/1% | 0.294 | 0.113 | 11% | 15%/0% | 0.453 | 0.237 | 20% | 15%/1% | 0.323 | 0.109 | 10% | 35%/0% |
| 60-90 | 222 | 0.389 | 0.197 | 19% | 0%/18% | 0.376 | 0.158 | 27% | 0%/16% | 0.565 | 0.291 | 38% | 1%/13% | 0.506 | 0.216 | 52% | 0%/7% |
| 90-120 | 225 | 0.357 | 0.177 | 32% | 0%/4% | 0.371 | 0.127 | 34% | 3%/1% | 0.514 | 0.282 | 38% | 0%/6% | 0.446 | 0.190 | 42% | 6%/0% |

### synthetic-r1-test by pollution

| pollution | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| heavy | 235 | 0.267 | 0.122 | 17% | 4%/6% | 0.285 | 0.104 | 17% | 9%/5% | 0.445 | 0.214 | 32% | 3%/7% | 0.398 | 0.130 | 32% | 17%/3% |
| light | 330 | 0.369 | 0.177 | 25% | 4%/5% | 0.389 | 0.136 | 28% | 5%/4% | 0.536 | 0.286 | 35% | 5%/5% | 0.424 | 0.174 | 32% | 17%/1% |
| medium | 301 | 0.281 | 0.147 | 18% | 4%/5% | 0.294 | 0.121 | 22% | 10%/3% | 0.488 | 0.246 | 28% | 10%/5% | 0.390 | 0.151 | 30% | 19%/1% |
| none | 134 | 0.413 | 0.233 | 25% | 5%/5% | 0.462 | 0.195 | 28% | 15%/4% | 0.539 | 0.308 | 35% | 10%/3% | 0.437 | 0.189 | 28% | 23%/2% |

### synthetic-r1-test by style

| style | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| straight | 368 | 0.342 | 0.177 | 20% | 4%/5% | 0.364 | 0.159 | 23% | 8%/5% | 0.530 | 0.288 | 31% | 8%/6% | 0.433 | 0.177 | 32% | 19%/2% |
| swung | 228 | 0.409 | 0.178 | 32% | 6%/0% | 0.420 | 0.133 | 31% | 12%/0% | 0.603 | 0.279 | 43% | 8%/1% | 0.502 | 0.186 | 37% | 24%/0% |
| syncopated | 404 | 0.260 | 0.141 | 17% | 3%/9% | 0.287 | 0.106 | 20% | 7%/5% | 0.417 | 0.224 | 27% | 5%/7% | 0.335 | 0.126 | 26% | 14%/2% |

### synthetic-r1-test by start

| start | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| downbeat | 325 | 0.324 | 0.202 | 19% | 4%/5% | 0.356 | 0.172 | 22% | 9%/4% | 0.508 | 0.323 | 31% | 6%/4% | 0.415 | 0.211 | 31% | 14%/1% |
| midbar | 285 | 0.327 | 0.157 | 22% | 4%/7% | 0.340 | 0.124 | 27% | 8%/4% | 0.495 | 0.231 | 32% | 7%/6% | 0.403 | 0.139 | 33% | 19%/2% |
| pickup | 390 | 0.322 | 0.133 | 22% | 4%/5% | 0.341 | 0.104 | 23% | 9%/4% | 0.499 | 0.229 | 33% | 8%/6% | 0.409 | 0.129 | 29% | 21%/2% |

### synthetic-r1-test by bars

| bars | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2.0 | 354 | 0.237 | 0.126 | 12% | 2%/3% | 0.281 | 0.107 | 16% | 7%/2% | 0.457 | 0.250 | 25% | 6%/5% | 0.338 | 0.127 | 25% | 15%/1% |
| 4.0 | 320 | 0.353 | 0.166 | 24% | 4%/7% | 0.363 | 0.136 | 27% | 7%/5% | 0.513 | 0.245 | 33% | 7%/5% | 0.434 | 0.176 | 35% | 16%/2% |
| 8.0 | 326 | 0.391 | 0.199 | 28% | 7%/7% | 0.399 | 0.154 | 28% | 11%/5% | 0.537 | 0.286 | 39% | 8%/5% | 0.462 | 0.177 | 33% | 25%/2% |

## synthetic-r1-test-unseen

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 500 | 0.324 | 0.152 | 21% | 4%/8% | 0.336 | 0.114 | 25% | 9%/5% | 0.478 | 0.262 | 29% | 7%/8% | 0.401 | 0.151 | 28% | 19%/3% |

### synthetic-r1-test-unseen: grid correct (one steady grid with bar lines; see scripts/score.py grid_correct)

| model | clips | grid (meant tempo, 70 ms) | grid (meant tempo, 1/4 beat) | grid (no hint, 70 ms) | grid (no hint, 1/4 beat) | tempo right, bars wrong (meant, 70 ms) | tempo right, bars wrong (no hint, 70 ms) |
|---|---|---|---|---|---|---|---|
| final0 | 500 | 1% | 2% | 1% | 1% | 30% | 18% |
| final0+dbn | 500 | 2% | 2% | 2% | 2% | 35% | 20% |
| final | 500 | 2% | 2% | 2% | 2% | 41% | 23% |
| final+dbn | 500 | 3% | 3% | 2% | 2% | 48% | 24% |

### synthetic-r1-test-unseen by lead

| lead | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| breathy | 79 | 0.158 | 0.072 | 13% | 4%/5% | 0.227 | 0.058 | 19% | 4%/3% | 0.478 | 0.287 | 25% | 10%/10% | 0.404 | 0.158 | 25% | 19%/4% |
| instrument | 201 | 0.411 | 0.194 | 29% | 3%/11% | 0.403 | 0.148 | 31% | 11%/6% | 0.516 | 0.253 | 33% | 2%/10% | 0.419 | 0.175 | 35% | 16%/4% |
| voice | 220 | 0.305 | 0.142 | 17% | 5%/5% | 0.314 | 0.103 | 21% | 9%/4% | 0.444 | 0.260 | 26% | 10%/4% | 0.384 | 0.126 | 22% | 21%/2% |

### synthetic-r1-test-unseen by lead_group

| lead_group | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bass | 49 | 0.391 | 0.185 | 24% | 2%/14% | 0.380 | 0.136 | 22% | 10%/8% | 0.464 | 0.263 | 37% | 6%/10% | 0.382 | 0.200 | 29% | 14%/10% |
| breathy | 79 | 0.158 | 0.072 | 13% | 4%/5% | 0.227 | 0.058 | 19% | 4%/3% | 0.478 | 0.287 | 25% | 10%/10% | 0.404 | 0.158 | 25% | 19%/4% |
| guitar | 38 | 0.462 | 0.224 | 32% | 5%/13% | 0.393 | 0.185 | 32% | 11%/8% | 0.496 | 0.289 | 29% | 0%/11% | 0.410 | 0.169 | 37% | 13%/3% |
| keys | 38 | 0.421 | 0.177 | 32% | 3%/5% | 0.390 | 0.118 | 37% | 8%/3% | 0.557 | 0.234 | 34% | 0%/13% | 0.451 | 0.124 | 45% | 11%/3% |
| strings_brass | 39 | 0.425 | 0.237 | 31% | 3%/15% | 0.458 | 0.201 | 38% | 8%/5% | 0.582 | 0.238 | 33% | 3%/10% | 0.447 | 0.143 | 31% | 18%/3% |
| synth | 37 | 0.359 | 0.149 | 27% | 5%/8% | 0.396 | 0.100 | 30% | 19%/8% | 0.492 | 0.241 | 30% | 3%/8% | 0.414 | 0.233 | 35% | 27%/3% |
| voice | 220 | 0.305 | 0.142 | 17% | 5%/5% | 0.314 | 0.103 | 21% | 9%/4% | 0.444 | 0.260 | 26% | 10%/4% | 0.384 | 0.126 | 22% | 21%/2% |

### synthetic-r1-test-unseen by timing

| timing | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| humanised | 210 | 0.311 | 0.126 | 22% | 3%/4% | 0.323 | 0.089 | 23% | 9%/3% | 0.469 | 0.255 | 30% | 9%/8% | 0.393 | 0.145 | 31% | 19%/2% |
| irregular | 158 | 0.304 | 0.149 | 14% | 2%/11% | 0.326 | 0.122 | 18% | 8%/7% | 0.441 | 0.236 | 19% | 4%/5% | 0.359 | 0.134 | 19% | 15%/3% |
| perfect | 132 | 0.370 | 0.196 | 29% | 8%/10% | 0.369 | 0.144 | 36% | 9%/5% | 0.538 | 0.302 | 39% | 8%/11% | 0.464 | 0.181 | 33% | 23%/6% |

### synthetic-r1-test-unseen by meter

| meter | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 3/4 | 164 | 0.356 | 0.142 | 24% | 4%/11% | 0.343 | 0.114 | 34% | 7%/6% | 0.504 | 0.236 | 35% | 5%/13% | 0.422 | 0.125 | 38% | 20%/5% |
| 4/4 | 171 | 0.354 | 0.142 | 22% | 5%/11% | 0.384 | 0.115 | 26% | 14%/8% | 0.495 | 0.238 | 30% | 6%/8% | 0.430 | 0.163 | 29% | 19%/4% |
| 6/8 | 165 | 0.262 | 0.172 | 18% | 3%/1% | 0.279 | 0.113 | 15% | 5%/1% | 0.435 | 0.312 | 22% | 9%/1% | 0.351 | 0.164 | 17% | 18%/1% |

### synthetic-r1-test-unseen by tempo_band

| tempo_band | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 120-150 | 107 | 0.304 | 0.138 | 22% | 7%/5% | 0.364 | 0.108 | 31% | 13%/0% | 0.488 | 0.249 | 41% | 6%/2% | 0.412 | 0.146 | 30% | 27%/0% |
| 150-200 | 166 | 0.260 | 0.107 | 13% | 7%/1% | 0.277 | 0.091 | 11% | 15%/0% | 0.431 | 0.234 | 14% | 16%/1% | 0.337 | 0.101 | 8% | 35%/0% |
| 60-90 | 121 | 0.380 | 0.184 | 22% | 0%/21% | 0.338 | 0.107 | 24% | 0%/19% | 0.525 | 0.275 | 31% | 0%/21% | 0.469 | 0.208 | 46% | 0%/12% |
| 90-120 | 106 | 0.382 | 0.201 | 32% | 1%/7% | 0.396 | 0.164 | 41% | 5%/1% | 0.488 | 0.302 | 37% | 2%/8% | 0.413 | 0.167 | 36% | 8%/2% |

### synthetic-r1-test-unseen by pollution

| pollution | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| heavy | 124 | 0.207 | 0.097 | 10% | 2%/5% | 0.241 | 0.087 | 13% | 6%/2% | 0.410 | 0.236 | 19% | 10%/2% | 0.356 | 0.135 | 16% | 20%/2% |
| light | 156 | 0.353 | 0.152 | 24% | 4%/10% | 0.353 | 0.101 | 29% | 6%/8% | 0.493 | 0.264 | 31% | 6%/11% | 0.396 | 0.135 | 31% | 15%/5% |
| medium | 142 | 0.345 | 0.173 | 25% | 5%/8% | 0.357 | 0.130 | 26% | 13%/4% | 0.489 | 0.263 | 29% | 8%/9% | 0.414 | 0.155 | 30% | 23%/3% |
| none | 78 | 0.417 | 0.202 | 27% | 4%/6% | 0.413 | 0.155 | 33% | 10%/5% | 0.537 | 0.296 | 40% | 3%/6% | 0.462 | 0.200 | 37% | 18%/1% |

### synthetic-r1-test-unseen by style

| style | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| straight | 198 | 0.327 | 0.167 | 20% | 5%/10% | 0.358 | 0.129 | 24% | 7%/6% | 0.509 | 0.296 | 26% | 7%/11% | 0.429 | 0.177 | 31% | 20%/4% |
| swung | 111 | 0.457 | 0.185 | 36% | 5%/2% | 0.431 | 0.144 | 38% | 12%/2% | 0.594 | 0.278 | 44% | 5%/0% | 0.496 | 0.171 | 32% | 23%/0% |
| syncopated | 191 | 0.245 | 0.118 | 14% | 3%/9% | 0.257 | 0.081 | 18% | 9%/6% | 0.379 | 0.216 | 23% | 8%/9% | 0.317 | 0.112 | 22% | 16%/5% |

### synthetic-r1-test-unseen by start

| start | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| downbeat | 159 | 0.344 | 0.196 | 19% | 5%/9% | 0.356 | 0.147 | 25% | 9%/4% | 0.499 | 0.338 | 28% | 10%/6% | 0.428 | 0.220 | 26% | 25%/3% |
| midbar | 136 | 0.274 | 0.133 | 21% | 4%/3% | 0.277 | 0.105 | 21% | 9%/1% | 0.422 | 0.237 | 26% | 6%/7% | 0.332 | 0.122 | 21% | 21%/1% |
| pickup | 205 | 0.343 | 0.130 | 23% | 3%/10% | 0.359 | 0.094 | 27% | 8%/8% | 0.500 | 0.218 | 32% | 5%/9% | 0.426 | 0.117 | 34% | 14%/5% |

### synthetic-r1-test-unseen by bars

| bars | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2.0 | 152 | 0.300 | 0.119 | 17% | 1%/7% | 0.295 | 0.080 | 18% | 7%/5% | 0.436 | 0.236 | 26% | 4%/11% | 0.325 | 0.114 | 22% | 16%/5% |
| 4.0 | 180 | 0.274 | 0.146 | 17% | 6%/6% | 0.301 | 0.109 | 20% | 9%/4% | 0.474 | 0.269 | 27% | 9%/5% | 0.405 | 0.144 | 26% | 19%/1% |
| 8.0 | 168 | 0.401 | 0.189 | 29% | 5%/10% | 0.411 | 0.150 | 36% | 10%/5% | 0.520 | 0.277 | 33% | 8%/7% | 0.466 | 0.191 | 35% | 21%/4% |

## humtrans-dev

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 149 | 0.558 | 0.324 | 56% | 1%/24% | 0.553 | 0.329 | 72% | 1%/13% | 0.671 | 0.375 | 52% | 2%/28% | 0.673 | 0.422 | 78% | 4%/9% |

### humtrans-dev: grid correct (one steady grid with bar lines; see scripts/score.py grid_correct)

| model | clips | grid (meant tempo, 70 ms) | grid (meant tempo, 1/4 beat) | grid (no hint, 70 ms) | grid (no hint, 1/4 beat) | tempo right, bars wrong (meant, 70 ms) | tempo right, bars wrong (no hint, 70 ms) |
|---|---|---|---|---|---|---|---|
| final0 | 149 | 10% | 15% | 9% | 14% | 66% | 55% |
| final0+dbn | 149 | 18% | 28% | 17% | 26% | 64% | 54% |
| final | 149 | 4% | 5% | 4% | 5% | 72% | 61% |
| final+dbn | 149 | 30% | 32% | 28% | 31% | 62% | 52% |

### humtrans-dev by tempo_band

| tempo_band | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 120-150 | 9 | 0.635 | 0.400 | 89% | 0%/0% | 0.644 | 0.295 | 89% | 0%/0% | 0.808 | 0.517 | 67% | 22%/0% | 0.791 | 0.620 | 67% | 22%/0% |
| 150-200 | 5 | 0.828 | 0.574 | 80% | 20%/0% | 0.784 | 0.658 | 60% | 40%/0% | 0.831 | 0.520 | 80% | 20%/0% | 0.767 | 0.456 | 40% | 60%/0% |
| 60-90 | 67 | 0.493 | 0.251 | 51% | 0%/31% | 0.468 | 0.245 | 60% | 0%/27% | 0.607 | 0.322 | 49% | 0%/36% | 0.613 | 0.366 | 75% | 0%/16% |
| 90-120 | 68 | 0.591 | 0.367 | 54% | 0%/22% | 0.609 | 0.393 | 82% | 0%/1% | 0.703 | 0.397 | 51% | 0%/26% | 0.710 | 0.448 | 85% | 1%/4% |

### humtrans-dev by singer

| singer | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| F01 | 11 | 0.451 | 0.189 | 45% | 0%/45% | 0.408 | 0.173 | 64% | 0%/18% | 0.694 | 0.399 | 27% | 0%/45% | 0.674 | 0.393 | 73% | 0%/18% |
| F02 | 17 | 0.503 | 0.324 | 41% | 0%/35% | 0.532 | 0.242 | 65% | 0%/24% | 0.593 | 0.385 | 53% | 12%/29% | 0.512 | 0.413 | 88% | 12%/0% |
| F03 | 12 | 0.486 | 0.142 | 33% | 0%/25% | 0.497 | 0.197 | 50% | 0%/8% | 0.686 | 0.328 | 58% | 0%/17% | 0.690 | 0.327 | 67% | 0%/8% |
| F04 | 12 | 0.600 | 0.333 | 50% | 8%/33% | 0.480 | 0.257 | 83% | 8%/8% | 0.718 | 0.325 | 67% | 0%/8% | 0.697 | 0.366 | 92% | 0%/0% |
| F05 | 19 | 0.655 | 0.423 | 63% | 0%/21% | 0.649 | 0.446 | 79% | 0%/11% | 0.694 | 0.426 | 47% | 0%/37% | 0.747 | 0.476 | 68% | 5%/16% |
| M01 | 13 | 0.600 | 0.368 | 62% | 0%/15% | 0.586 | 0.390 | 62% | 0%/15% | 0.697 | 0.364 | 46% | 0%/23% | 0.701 | 0.344 | 77% | 0%/8% |
| M02 | 13 | 0.438 | 0.267 | 77% | 0%/8% | 0.380 | 0.282 | 77% | 8%/0% | 0.638 | 0.415 | 77% | 0%/8% | 0.630 | 0.512 | 77% | 8%/0% |
| M03 | 19 | 0.609 | 0.371 | 68% | 0%/16% | 0.698 | 0.454 | 89% | 0%/5% | 0.671 | 0.387 | 42% | 5%/37% | 0.700 | 0.374 | 74% | 11%/16% |
| M04 | 20 | 0.535 | 0.344 | 70% | 0%/15% | 0.543 | 0.344 | 80% | 0%/5% | 0.653 | 0.334 | 60% | 0%/20% | 0.710 | 0.562 | 85% | 0%/5% |
| M05 | 13 | 0.644 | 0.366 | 31% | 0%/38% | 0.631 | 0.377 | 54% | 0%/38% | 0.693 | 0.371 | 46% | 0%/54% | 0.660 | 0.362 | 77% | 0%/23% |

## gtzan-vocals-dev

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 358 | 0.359 | 0.240 | 38% | 11%/7% | 0.435 | 0.260 | 48% | 15%/4% | 0.463 | 0.260 | 38% | 8%/11% | 0.449 | 0.213 | 45% | 17%/3% |

### gtzan-vocals-dev: grid correct (one steady grid with bar lines; see scripts/score.py grid_correct)

| model | clips | grid (meant tempo, 70 ms) | grid (meant tempo, 1/4 beat) | grid (no hint, 70 ms) | grid (no hint, 1/4 beat) | tempo right, bars wrong (meant, 70 ms) | tempo right, bars wrong (no hint, 70 ms) |
|---|---|---|---|---|---|---|---|
| final0 | 358 | 3% | 4% | 3% | 4% | 54% | 42% |
| final0+dbn | 358 | 8% | 11% | 8% | 11% | 58% | 44% |
| final | 358 | 2% | 2% | 1% | 1% | 54% | 41% |
| final+dbn | 358 | 6% | 7% | 6% | 7% | 59% | 46% |

### gtzan-vocals-dev by genre

| genre | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| blues | 41 | 0.212 | 0.121 | 15% | 7%/2% | 0.311 | 0.111 | 27% | 12%/0% | 0.377 | 0.212 | 24% | 5%/7% | 0.354 | 0.136 | 24% | 22%/0% |
| classical | 4 | 0.234 | 0.135 | 50% | 0%/0% | 0.214 | 0.155 | 75% | 0%/0% | 0.266 | 0.170 | 25% | 0%/0% | 0.254 | 0.206 | 25% | 0%/0% |
| country | 47 | 0.306 | 0.230 | 34% | 21%/2% | 0.359 | 0.222 | 32% | 21%/2% | 0.404 | 0.247 | 30% | 13%/6% | 0.387 | 0.186 | 28% | 23%/2% |
| disco | 42 | 0.569 | 0.439 | 71% | 7%/2% | 0.622 | 0.490 | 81% | 10%/2% | 0.610 | 0.386 | 76% | 2%/0% | 0.635 | 0.379 | 76% | 7%/0% |
| hiphop | 47 | 0.347 | 0.132 | 49% | 2%/11% | 0.394 | 0.146 | 55% | 0%/4% | 0.541 | 0.235 | 38% | 0%/17% | 0.550 | 0.142 | 57% | 4%/9% |
| jazz | 11 | 0.308 | 0.203 | 18% | 0%/0% | 0.354 | 0.201 | 27% | 18%/0% | 0.239 | 0.114 | 18% | 0%/0% | 0.244 | 0.072 | 36% | 0%/0% |
| metal | 30 | 0.217 | 0.192 | 13% | 23%/3% | 0.387 | 0.209 | 27% | 40%/3% | 0.435 | 0.258 | 37% | 23%/3% | 0.354 | 0.155 | 20% | 30%/3% |
| pop | 49 | 0.512 | 0.347 | 63% | 0%/16% | 0.557 | 0.391 | 80% | 0%/8% | 0.523 | 0.284 | 43% | 0%/24% | 0.460 | 0.257 | 73% | 2%/6% |
| reggae | 40 | 0.295 | 0.186 | 12% | 30%/5% | 0.375 | 0.176 | 20% | 35%/2% | 0.443 | 0.250 | 30% | 22%/5% | 0.429 | 0.204 | 25% | 38%/0% |
| rock | 47 | 0.372 | 0.265 | 36% | 9%/13% | 0.486 | 0.327 | 51% | 11%/9% | 0.432 | 0.253 | 34% | 11%/19% | 0.456 | 0.256 | 49% | 21%/4% |

## gtzan-mix-dev

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 498 | 0.888 | 0.794 | 82% | 6%/6% | 0.876 | 0.789 | 83% | 8%/3% | 0.855 | 0.751 | 77% | 11%/6% | 0.846 | 0.744 | 79% | 14%/2% |

### gtzan-mix-dev: grid correct (one steady grid with bar lines; see scripts/score.py grid_correct)

| model | clips | grid (meant tempo, 70 ms) | grid (meant tempo, 1/4 beat) | grid (no hint, 70 ms) | grid (no hint, 1/4 beat) | tempo right, bars wrong (meant, 70 ms) | tempo right, bars wrong (no hint, 70 ms) |
|---|---|---|---|---|---|---|---|
| final0 | 498 | 33% | 37% | 27% | 30% | 60% | 40% |
| final0+dbn | 498 | 35% | 39% | 30% | 33% | 59% | 37% |
| final | 498 | 29% | 32% | 24% | 26% | 65% | 44% |
| final+dbn | 498 | 33% | 37% | 29% | 32% | 63% | 40% |

### gtzan-mix-dev by genre

| genre | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F final0+dbn | downbeat F final0+dbn | tempo ok final0+dbn | half/double final0+dbn | beat F final | downbeat F final | tempo ok final | half/double final | beat F final+dbn | downbeat F final+dbn | tempo ok final+dbn | half/double final+dbn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| blues | 50 | 0.806 | 0.672 | 66% | 2%/12% | 0.793 | 0.691 | 74% | 4%/8% | 0.814 | 0.641 | 62% | 0%/20% | 0.783 | 0.618 | 78% | 6%/4% |
| classical | 50 | 0.665 | 0.524 | 62% | 8%/10% | 0.637 | 0.513 | 66% | 8%/6% | 0.617 | 0.452 | 62% | 16%/4% | 0.597 | 0.429 | 58% | 22%/2% |
| country | 50 | 0.929 | 0.916 | 84% | 14%/0% | 0.907 | 0.892 | 82% | 18%/0% | 0.872 | 0.862 | 68% | 30%/2% | 0.874 | 0.845 | 68% | 30%/2% |
| disco | 50 | 0.985 | 0.945 | 96% | 2%/0% | 0.988 | 0.964 | 98% | 2%/0% | 0.988 | 0.964 | 98% | 2%/0% | 0.990 | 0.989 | 98% | 2%/0% |
| hiphop | 50 | 0.964 | 0.881 | 94% | 0%/2% | 0.961 | 0.886 | 98% | 0%/0% | 0.929 | 0.839 | 88% | 0%/8% | 0.928 | 0.862 | 96% | 2%/2% |
| jazz | 49 | 0.860 | 0.786 | 78% | 6%/8% | 0.832 | 0.763 | 76% | 6%/0% | 0.782 | 0.659 | 71% | 10%/6% | 0.786 | 0.717 | 73% | 12%/2% |
| metal | 50 | 0.877 | 0.761 | 80% | 4%/12% | 0.846 | 0.761 | 74% | 14%/6% | 0.836 | 0.725 | 72% | 14%/6% | 0.788 | 0.722 | 72% | 22%/2% |
| pop | 50 | 0.980 | 0.968 | 96% | 0%/4% | 0.979 | 0.960 | 96% | 0%/4% | 0.977 | 0.951 | 96% | 0%/4% | 0.979 | 0.958 | 96% | 0%/4% |
| reggae | 49 | 0.892 | 0.652 | 71% | 27%/2% | 0.900 | 0.614 | 71% | 27%/2% | 0.836 | 0.600 | 57% | 41%/0% | 0.826 | 0.526 | 57% | 43%/0% |
| rock | 50 | 0.921 | 0.831 | 88% | 2%/6% | 0.920 | 0.837 | 92% | 2%/4% | 0.902 | 0.800 | 90% | 2%/6% | 0.904 | 0.766 | 90% | 6%/4% |
