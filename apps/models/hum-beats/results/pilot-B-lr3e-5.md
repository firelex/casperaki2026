# Scores (same files for every model)

Beat and downbeat F-measure: mir_eval, 70 ms window, mean over clips, nothing trimmed. Tempo ok: the median predicted beat interval is within 4% of the labelled one (hum-lab: of the meant tempo); half/double: within 4% of half or double.


## dev-humtrans

| set | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| all | 149 | 0.607 | 0.300 | 31% | 0%/41% |

### dev-humtrans by tempo_band

| tempo_band | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| 120-150 | 9 | 0.753 | 0.381 | 56% | 0%/11% |
| 150-200 | 5 | 0.822 | 0.484 | 100% | 0%/0% |
| 60-90 | 67 | 0.538 | 0.238 | 15% | 0%/57% |
| 90-120 | 68 | 0.640 | 0.337 | 38% | 0%/32% |

### dev-humtrans by singer

| singer | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| F01 | 11 | 0.551 | 0.229 | 0% | 0%/82% |
| F02 | 17 | 0.583 | 0.262 | 12% | 0%/53% |
| F03 | 12 | 0.637 | 0.266 | 33% | 0%/33% |
| F04 | 12 | 0.653 | 0.308 | 50% | 0%/25% |
| F05 | 19 | 0.648 | 0.341 | 53% | 0%/37% |
| M01 | 13 | 0.597 | 0.298 | 23% | 0%/31% |
| M02 | 13 | 0.494 | 0.234 | 38% | 0%/38% |
| M03 | 19 | 0.639 | 0.364 | 37% | 0%/26% |
| M04 | 20 | 0.592 | 0.336 | 35% | 0%/30% |
| M05 | 13 | 0.655 | 0.293 | 15% | 0%/69% |

## gtzan-mix-dev

| set | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| all | 498 | 0.858 | 0.663 | 73% | 6%/8% |

### gtzan-mix-dev by genre

| genre | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| blues | 50 | 0.805 | 0.543 | 62% | 0%/12% |
| classical | 50 | 0.657 | 0.479 | 56% | 12%/4% |
| country | 50 | 0.901 | 0.813 | 84% | 10%/2% |
| disco | 50 | 0.962 | 0.859 | 92% | 0%/2% |
| hiphop | 50 | 0.902 | 0.709 | 80% | 0%/12% |
| jazz | 49 | 0.798 | 0.574 | 67% | 12%/4% |
| metal | 50 | 0.834 | 0.596 | 54% | 8%/14% |
| pop | 50 | 0.923 | 0.775 | 80% | 2%/14% |
| reggae | 49 | 0.913 | 0.599 | 78% | 16%/4% |
| rock | 50 | 0.889 | 0.673 | 78% | 2%/14% |

## gtzan-vocals-dev

| set | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| all | 358 | 0.468 | 0.230 | 22% | 1%/13% |

### gtzan-vocals-dev by genre

| genre | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| blues | 41 | 0.382 | 0.169 | 17% | 0%/10% |
| classical | 4 | 0.222 | 0.162 | 0% | 0%/0% |
| country | 47 | 0.447 | 0.249 | 32% | 0%/11% |
| disco | 42 | 0.581 | 0.329 | 36% | 0%/2% |
| hiphop | 47 | 0.460 | 0.183 | 9% | 0%/15% |
| jazz | 11 | 0.309 | 0.172 | 18% | 0%/0% |
| metal | 30 | 0.488 | 0.236 | 27% | 0%/10% |
| pop | 49 | 0.522 | 0.219 | 14% | 0%/31% |
| reggae | 40 | 0.458 | 0.235 | 22% | 10%/8% |
| rock | 47 | 0.468 | 0.242 | 26% | 2%/21% |

## r2-dev

| set | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| all | 590 | 0.447 | 0.195 | 11% | 1%/31% |

### r2-dev by lead

| lead | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| breathy | 42 | 0.407 | 0.172 | 7% | 0%/26% |
| instrument | 138 | 0.476 | 0.226 | 14% | 1%/38% |
| voice | 410 | 0.442 | 0.187 | 10% | 1%/30% |

### r2-dev by lead_group

| lead_group | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| bass | 27 | 0.462 | 0.213 | 15% | 0%/37% |
| breathy | 42 | 0.407 | 0.172 | 7% | 0%/26% |
| guitar | 32 | 0.554 | 0.273 | 16% | 0%/28% |
| keys | 20 | 0.476 | 0.252 | 5% | 0%/45% |
| soulx | 223 | 0.444 | 0.181 | 9% | 0%/32% |
| strings_brass | 25 | 0.381 | 0.167 | 24% | 0%/20% |
| synth | 34 | 0.483 | 0.219 | 12% | 3%/56% |
| vocal_sample | 17 | 0.482 | 0.226 | 12% | 0%/35% |
| voice | 170 | 0.434 | 0.192 | 11% | 1%/26% |

### r2-dev by timing

| timing | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| perfect | 62 | 0.434 | 0.182 | 18% | 0%/32% |
| real | 528 | 0.449 | 0.197 | 10% | 1%/31% |

### r2-dev by meter

| meter | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| 2/4 | 84 | 0.406 | 0.245 | 10% | 0%/29% |
| 3/4 | 120 | 0.465 | 0.196 | 12% | 1%/36% |
| 4/4 | 334 | 0.448 | 0.171 | 9% | 1%/34% |
| 6/8 | 52 | 0.469 | 0.269 | 19% | 2%/10% |

### r2-dev by tempo_band

| tempo_band | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| 120-150 | 60 | 0.411 | 0.224 | 12% | 0%/18% |
| 150-200 | 61 | 0.418 | 0.168 | 15% | 7%/11% |
| 60-90 | 213 | 0.476 | 0.202 | 9% | 0%/44% |
| 90-120 | 256 | 0.438 | 0.190 | 11% | 0%/29% |

### r2-dev by pollution

| pollution | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| heavy | 144 | 0.398 | 0.170 | 12% | 1%/25% |
| light | 175 | 0.463 | 0.200 | 11% | 1%/34% |
| medium | 177 | 0.443 | 0.186 | 10% | 1%/32% |
| none | 94 | 0.500 | 0.241 | 10% | 0%/35% |

### r2-dev by style

| style | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| straight | 380 | 0.451 | 0.200 | 10% | 0%/34% |
| swung | 71 | 0.477 | 0.202 | 14% | 3%/14% |
| syncopated | 139 | 0.420 | 0.180 | 10% | 1%/34% |

### r2-dev by start

| start | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| downbeat | 191 | 0.457 | 0.229 | 11% | 0%/31% |
| midbar | 168 | 0.408 | 0.153 | 8% | 1%/32% |
| pickup | 231 | 0.467 | 0.198 | 13% | 1%/31% |

### r2-dev by bars

| bars | clips | beat F B-lr3e-5 | downbeat F B-lr3e-5 | tempo ok B-lr3e-5 | half/double B-lr3e-5 |
|---|---|---|---|---|---|
| 2.0 | 191 | 0.421 | 0.171 | 13% | 1%/27% |
| 4.0 | 197 | 0.446 | 0.186 | 11% | 1%/34% |
| 8.0 | 202 | 0.472 | 0.228 | 8% | 0%/33% |
