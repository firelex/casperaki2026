# Scores (same files for every model)

Beat and downbeat F-measure: mir_eval, 70 ms window, mean over clips, nothing trimmed. Tempo ok: the median predicted beat interval is within 4% of the labelled one (hum-lab: of the meant tempo); half/double: within 4% of half or double.


## dev-humtrans

| set | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| all | 149 | 0.639 | 0.324 | 34% | 1%/38% |

### dev-humtrans by tempo_band

| tempo_band | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| 120-150 | 9 | 0.788 | 0.418 | 78% | 0%/0% |
| 150-200 | 5 | 0.844 | 0.459 | 80% | 20%/0% |
| 60-90 | 67 | 0.562 | 0.267 | 21% | 0%/58% |
| 90-120 | 68 | 0.680 | 0.359 | 38% | 0%/25% |

### dev-humtrans by singer

| singer | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| F01 | 11 | 0.603 | 0.284 | 9% | 0%/73% |
| F02 | 17 | 0.623 | 0.311 | 41% | 0%/35% |
| F03 | 12 | 0.669 | 0.283 | 33% | 0%/33% |
| F04 | 12 | 0.680 | 0.320 | 58% | 0%/8% |
| F05 | 19 | 0.644 | 0.340 | 42% | 0%/26% |
| M01 | 13 | 0.626 | 0.331 | 31% | 0%/23% |
| M02 | 13 | 0.525 | 0.259 | 23% | 8%/31% |
| M03 | 19 | 0.665 | 0.394 | 37% | 0%/53% |
| M04 | 20 | 0.641 | 0.350 | 40% | 0%/25% |
| M05 | 13 | 0.704 | 0.310 | 15% | 0%/77% |

## gtzan-mix-dev

| set | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| all | 498 | 0.855 | 0.679 | 72% | 7%/8% |

### gtzan-mix-dev by genre

| genre | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| blues | 50 | 0.782 | 0.565 | 58% | 2%/18% |
| classical | 50 | 0.646 | 0.458 | 56% | 12%/4% |
| country | 50 | 0.912 | 0.831 | 80% | 10%/4% |
| disco | 50 | 0.976 | 0.852 | 94% | 0%/0% |
| hiphop | 50 | 0.916 | 0.743 | 80% | 0%/14% |
| jazz | 49 | 0.758 | 0.580 | 55% | 18%/4% |
| metal | 50 | 0.831 | 0.616 | 60% | 8%/12% |
| pop | 50 | 0.935 | 0.789 | 86% | 2%/10% |
| reggae | 49 | 0.902 | 0.640 | 71% | 20%/0% |
| rock | 50 | 0.887 | 0.701 | 80% | 2%/18% |

## gtzan-vocals-dev

| set | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| all | 358 | 0.481 | 0.233 | 23% | 2%/16% |

### gtzan-vocals-dev by genre

| genre | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| blues | 41 | 0.416 | 0.192 | 17% | 0%/7% |
| classical | 4 | 0.255 | 0.159 | 0% | 0%/0% |
| country | 47 | 0.456 | 0.235 | 28% | 2%/13% |
| disco | 42 | 0.582 | 0.322 | 43% | 0%/17% |
| hiphop | 47 | 0.500 | 0.200 | 13% | 0%/21% |
| jazz | 11 | 0.298 | 0.137 | 27% | 0%/0% |
| metal | 30 | 0.463 | 0.226 | 23% | 7%/3% |
| pop | 49 | 0.546 | 0.231 | 16% | 0%/31% |
| reggae | 40 | 0.486 | 0.252 | 28% | 10%/10% |
| rock | 47 | 0.459 | 0.233 | 23% | 2%/23% |

## r2-dev

| set | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| all | 590 | 0.488 | 0.225 | 17% | 0%/29% |

### r2-dev by lead

| lead | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| breathy | 42 | 0.460 | 0.208 | 5% | 0%/38% |
| instrument | 138 | 0.509 | 0.238 | 17% | 0%/33% |
| voice | 410 | 0.484 | 0.223 | 18% | 0%/27% |

### r2-dev by lead_group

| lead_group | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| bass | 27 | 0.470 | 0.237 | 15% | 0%/37% |
| breathy | 42 | 0.460 | 0.208 | 5% | 0%/38% |
| guitar | 32 | 0.593 | 0.288 | 25% | 0%/25% |
| keys | 20 | 0.536 | 0.252 | 10% | 0%/35% |
| soulx | 223 | 0.482 | 0.216 | 14% | 0%/29% |
| strings_brass | 25 | 0.441 | 0.196 | 24% | 0%/32% |
| synth | 34 | 0.494 | 0.215 | 12% | 0%/38% |
| vocal_sample | 17 | 0.530 | 0.268 | 29% | 0%/24% |
| voice | 170 | 0.482 | 0.227 | 22% | 1%/24% |

### r2-dev by timing

| timing | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| perfect | 62 | 0.492 | 0.216 | 16% | 0%/34% |
| real | 528 | 0.488 | 0.227 | 17% | 0%/29% |

### r2-dev by meter

| meter | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| 2/4 | 84 | 0.442 | 0.296 | 13% | 0%/30% |
| 3/4 | 120 | 0.518 | 0.233 | 18% | 0%/31% |
| 4/4 | 334 | 0.483 | 0.192 | 15% | 1%/33% |
| 6/8 | 52 | 0.525 | 0.310 | 37% | 0%/0% |

### r2-dev by tempo_band

| tempo_band | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| 120-150 | 60 | 0.442 | 0.246 | 12% | 0%/22% |
| 150-200 | 61 | 0.451 | 0.194 | 11% | 3%/11% |
| 60-90 | 213 | 0.520 | 0.227 | 16% | 0%/38% |
| 90-120 | 256 | 0.481 | 0.226 | 20% | 0%/28% |

### r2-dev by pollution

| pollution | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| heavy | 144 | 0.431 | 0.200 | 13% | 1%/32% |
| light | 175 | 0.523 | 0.237 | 18% | 1%/29% |
| medium | 177 | 0.475 | 0.217 | 20% | 0%/27% |
| none | 94 | 0.534 | 0.260 | 15% | 0%/30% |

### r2-dev by style

| style | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| straight | 380 | 0.488 | 0.228 | 16% | 0%/32% |
| swung | 71 | 0.524 | 0.241 | 24% | 3%/11% |
| syncopated | 139 | 0.470 | 0.212 | 16% | 0%/31% |

### r2-dev by start

| start | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| downbeat | 191 | 0.503 | 0.263 | 19% | 0%/29% |
| midbar | 168 | 0.436 | 0.178 | 14% | 0%/29% |
| pickup | 231 | 0.514 | 0.229 | 17% | 1%/29% |

### r2-dev by bars

| bars | clips | beat F A-lr1e-4 | downbeat F A-lr1e-4 | tempo ok A-lr1e-4 | half/double A-lr1e-4 |
|---|---|---|---|---|---|
| 2.0 | 191 | 0.453 | 0.200 | 17% | 1%/27% |
| 4.0 | 197 | 0.495 | 0.228 | 17% | 0%/30% |
| 8.0 | 202 | 0.515 | 0.247 | 17% | 0%/30% |
