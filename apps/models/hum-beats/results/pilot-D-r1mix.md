# Scores (same files for every model)

Beat and downbeat F-measure: mir_eval, 70 ms window, mean over clips, nothing trimmed. Tempo ok: the median predicted beat interval is within 4% of the labelled one (hum-lab: of the meant tempo); half/double: within 4% of half or double.


## dev-humtrans

| set | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| all | 149 | 0.643 | 0.301 | 40% | 0%/38% |

### dev-humtrans by tempo_band

| tempo_band | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| 120-150 | 9 | 0.772 | 0.419 | 78% | 0%/0% |
| 150-200 | 5 | 0.877 | 0.453 | 100% | 0%/0% |
| 60-90 | 67 | 0.569 | 0.257 | 28% | 0%/54% |
| 90-120 | 68 | 0.682 | 0.318 | 41% | 0%/31% |

### dev-humtrans by singer

| singer | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| F01 | 11 | 0.604 | 0.282 | 9% | 0%/55% |
| F02 | 17 | 0.623 | 0.299 | 35% | 0%/41% |
| F03 | 12 | 0.661 | 0.235 | 33% | 0%/33% |
| F04 | 12 | 0.676 | 0.314 | 58% | 0%/33% |
| F05 | 19 | 0.637 | 0.318 | 47% | 0%/37% |
| M01 | 13 | 0.653 | 0.300 | 46% | 0%/31% |
| M02 | 13 | 0.593 | 0.248 | 38% | 0%/31% |
| M03 | 19 | 0.642 | 0.350 | 42% | 0%/37% |
| M04 | 20 | 0.647 | 0.314 | 50% | 0%/25% |
| M05 | 13 | 0.702 | 0.311 | 23% | 0%/69% |

## gtzan-mix-dev

| set | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| all | 498 | 0.841 | 0.649 | 69% | 10%/9% |

### gtzan-mix-dev by genre

| genre | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| blues | 50 | 0.779 | 0.548 | 56% | 2%/16% |
| classical | 50 | 0.631 | 0.453 | 52% | 16%/4% |
| country | 50 | 0.901 | 0.816 | 80% | 16%/0% |
| disco | 50 | 0.984 | 0.823 | 98% | 2%/0% |
| hiphop | 50 | 0.880 | 0.643 | 72% | 0%/18% |
| jazz | 49 | 0.755 | 0.575 | 49% | 22%/4% |
| metal | 50 | 0.788 | 0.594 | 56% | 10%/10% |
| pop | 50 | 0.930 | 0.747 | 82% | 2%/12% |
| reggae | 49 | 0.882 | 0.633 | 69% | 22%/6% |
| rock | 50 | 0.881 | 0.653 | 78% | 6%/16% |

## gtzan-vocals-dev

| set | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| all | 358 | 0.476 | 0.224 | 21% | 2%/17% |

### gtzan-vocals-dev by genre

| genre | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| blues | 41 | 0.407 | 0.185 | 15% | 0%/10% |
| classical | 4 | 0.260 | 0.153 | 0% | 0%/0% |
| country | 47 | 0.452 | 0.234 | 26% | 2%/13% |
| disco | 42 | 0.580 | 0.299 | 40% | 0%/5% |
| hiphop | 47 | 0.486 | 0.198 | 6% | 0%/30% |
| jazz | 11 | 0.294 | 0.152 | 9% | 0%/0% |
| metal | 30 | 0.470 | 0.225 | 27% | 3%/10% |
| pop | 49 | 0.544 | 0.223 | 16% | 0%/33% |
| reggae | 40 | 0.477 | 0.243 | 22% | 10%/10% |
| rock | 47 | 0.452 | 0.212 | 26% | 2%/26% |

## r2-dev

| set | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| all | 590 | 0.486 | 0.220 | 16% | 1%/33% |

### r2-dev by lead

| lead | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| breathy | 42 | 0.449 | 0.200 | 10% | 0%/31% |
| instrument | 138 | 0.506 | 0.240 | 18% | 1%/41% |
| voice | 410 | 0.483 | 0.216 | 16% | 1%/30% |

### r2-dev by lead_group

| lead_group | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| bass | 27 | 0.470 | 0.222 | 30% | 4%/41% |
| breathy | 42 | 0.449 | 0.200 | 10% | 0%/31% |
| guitar | 32 | 0.583 | 0.290 | 19% | 3%/34% |
| keys | 20 | 0.537 | 0.279 | 10% | 0%/50% |
| soulx | 223 | 0.480 | 0.213 | 13% | 1%/33% |
| strings_brass | 25 | 0.457 | 0.195 | 24% | 0%/44% |
| synth | 34 | 0.480 | 0.216 | 9% | 0%/41% |
| vocal_sample | 17 | 0.502 | 0.276 | 24% | 0%/35% |
| voice | 170 | 0.484 | 0.214 | 19% | 1%/25% |

### r2-dev by timing

| timing | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| perfect | 62 | 0.477 | 0.207 | 18% | 0%/35% |
| real | 528 | 0.487 | 0.222 | 16% | 1%/32% |

### r2-dev by meter

| meter | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| 2/4 | 84 | 0.450 | 0.290 | 13% | 1%/33% |
| 3/4 | 120 | 0.511 | 0.224 | 14% | 0%/37% |
| 4/4 | 334 | 0.480 | 0.186 | 14% | 1%/36% |
| 6/8 | 52 | 0.525 | 0.322 | 37% | 0%/2% |

### r2-dev by tempo_band

| tempo_band | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| 120-150 | 60 | 0.433 | 0.236 | 18% | 2%/23% |
| 150-200 | 61 | 0.443 | 0.184 | 10% | 7%/11% |
| 60-90 | 213 | 0.518 | 0.223 | 16% | 0%/45% |
| 90-120 | 256 | 0.482 | 0.223 | 17% | 0%/30% |

### r2-dev by pollution

| pollution | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| heavy | 144 | 0.431 | 0.192 | 12% | 2%/38% |
| light | 175 | 0.516 | 0.231 | 19% | 1%/33% |
| medium | 177 | 0.470 | 0.212 | 18% | 1%/28% |
| none | 94 | 0.544 | 0.260 | 13% | 0%/34% |

### r2-dev by style

| style | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| straight | 380 | 0.485 | 0.218 | 15% | 1%/36% |
| swung | 71 | 0.534 | 0.242 | 27% | 3%/13% |
| syncopated | 139 | 0.463 | 0.217 | 13% | 1%/35% |

### r2-dev by start

| start | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| downbeat | 191 | 0.501 | 0.249 | 18% | 1%/35% |
| midbar | 168 | 0.432 | 0.182 | 12% | 1%/34% |
| pickup | 231 | 0.513 | 0.225 | 17% | 1%/30% |

### r2-dev by bars

| bars | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| 2.0 | 191 | 0.468 | 0.194 | 16% | 1%/24% |
| 4.0 | 197 | 0.484 | 0.224 | 17% | 1%/36% |
| 8.0 | 202 | 0.504 | 0.241 | 15% | 1%/38% |

## r2b-dev

| set | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| all | 593 | 0.507 | 0.238 | 24% | 0%/24% |

### r2b-dev by lead

| lead | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| breathy | 42 | 0.452 | 0.200 | 14% | 0%/24% |
| instrument | 138 | 0.547 | 0.262 | 31% | 0%/23% |
| voice | 413 | 0.499 | 0.234 | 23% | 0%/24% |

### r2b-dev by lead_group

| lead_group | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| bass | 27 | 0.541 | 0.263 | 26% | 0%/30% |
| breathy | 42 | 0.452 | 0.200 | 14% | 0%/24% |
| guitar | 32 | 0.580 | 0.276 | 34% | 0%/19% |
| keys | 20 | 0.584 | 0.282 | 35% | 0%/20% |
| soulx | 226 | 0.495 | 0.236 | 23% | 0%/23% |
| strings_brass | 25 | 0.490 | 0.237 | 36% | 0%/12% |
| synth | 34 | 0.542 | 0.253 | 26% | 0%/32% |
| vocal_sample | 17 | 0.541 | 0.252 | 18% | 0%/35% |
| voice | 170 | 0.499 | 0.230 | 25% | 1%/23% |

### r2b-dev by timing

| timing | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| perfect | 63 | 0.498 | 0.244 | 21% | 0%/33% |
| real | 530 | 0.508 | 0.237 | 25% | 0%/22% |

### r2b-dev by meter

| meter | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| 2/4 | 84 | 0.536 | 0.350 | 29% | 0%/26% |
| 3/4 | 124 | 0.520 | 0.245 | 25% | 1%/23% |
| 4/4 | 334 | 0.501 | 0.190 | 23% | 0%/27% |
| 6/8 | 51 | 0.464 | 0.353 | 24% | 0%/2% |

### r2b-dev by tempo_band

| tempo_band | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| 120-150 | 59 | 0.489 | 0.252 | 34% | 0%/5% |
| 150-200 | 66 | 0.487 | 0.210 | 29% | 3%/6% |
| 60-90 | 214 | 0.527 | 0.239 | 21% | 0%/41% |
| 90-120 | 254 | 0.498 | 0.242 | 24% | 0%/18% |

### r2b-dev by pollution

| pollution | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| heavy | 142 | 0.472 | 0.227 | 22% | 1%/22% |
| light | 179 | 0.523 | 0.257 | 26% | 1%/26% |
| medium | 179 | 0.511 | 0.220 | 26% | 0%/22% |
| none | 93 | 0.519 | 0.253 | 23% | 0%/26% |

### r2b-dev by style

| style | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| straight | 383 | 0.528 | 0.251 | 25% | 0%/25% |
| swung | 72 | 0.550 | 0.264 | 35% | 1%/14% |
| syncopated | 138 | 0.424 | 0.189 | 18% | 0%/25% |

### r2b-dev by start

| start | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| downbeat | 190 | 0.509 | 0.271 | 24% | 1%/22% |
| midbar | 173 | 0.475 | 0.194 | 23% | 0%/27% |
| pickup | 230 | 0.528 | 0.245 | 26% | 0%/23% |

### r2b-dev by bars

| bars | clips | beat F D-r1mix | downbeat F D-r1mix | tempo ok D-r1mix | half/double D-r1mix |
|---|---|---|---|---|---|
| 2.0 | 191 | 0.470 | 0.196 | 19% | 1%/20% |
| 4.0 | 197 | 0.509 | 0.247 | 25% | 0%/29% |
| 8.0 | 205 | 0.539 | 0.269 | 29% | 0%/22% |
