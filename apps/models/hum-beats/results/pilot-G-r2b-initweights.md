# Scores (same files for every model)

Beat and downbeat F-measure: mir_eval, 70 ms window, mean over clips, nothing trimmed. Tempo ok: the median predicted beat interval is within 4% of the labelled one (hum-lab: of the meant tempo); half/double: within 4% of half or double.


## dev-humtrans

| set | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| all | 149 | 0.666 | 0.346 | 50% | 0%/28% |

### dev-humtrans by tempo_band

| tempo_band | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| 120-150 | 9 | 0.823 | 0.450 | 89% | 0%/0% |
| 150-200 | 5 | 0.836 | 0.484 | 60% | 0%/0% |
| 60-90 | 67 | 0.581 | 0.286 | 43% | 0%/40% |
| 90-120 | 68 | 0.716 | 0.382 | 50% | 0%/21% |

### dev-humtrans by singer

| singer | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| F01 | 11 | 0.642 | 0.318 | 18% | 0%/73% |
| F02 | 17 | 0.654 | 0.336 | 47% | 0%/29% |
| F03 | 12 | 0.573 | 0.239 | 58% | 0%/17% |
| F04 | 12 | 0.691 | 0.368 | 67% | 0%/8% |
| F05 | 19 | 0.679 | 0.379 | 68% | 0%/21% |
| M01 | 13 | 0.650 | 0.374 | 38% | 0%/23% |
| M02 | 13 | 0.638 | 0.313 | 54% | 0%/8% |
| M03 | 19 | 0.683 | 0.401 | 42% | 0%/26% |
| M04 | 20 | 0.670 | 0.334 | 55% | 0%/25% |
| M05 | 13 | 0.754 | 0.363 | 38% | 0%/54% |

## gtzan-mix-dev

| set | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| all | 498 | 0.866 | 0.692 | 79% | 7%/7% |

### gtzan-mix-dev by genre

| genre | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| blues | 50 | 0.786 | 0.573 | 62% | 2%/16% |
| classical | 50 | 0.645 | 0.469 | 62% | 12%/4% |
| country | 50 | 0.915 | 0.849 | 84% | 10%/4% |
| disco | 50 | 0.988 | 0.869 | 98% | 2%/0% |
| hiphop | 50 | 0.924 | 0.762 | 82% | 0%/16% |
| jazz | 49 | 0.790 | 0.585 | 69% | 16%/4% |
| metal | 50 | 0.846 | 0.643 | 74% | 4%/10% |
| pop | 50 | 0.962 | 0.828 | 94% | 2%/2% |
| reggae | 49 | 0.897 | 0.634 | 71% | 24%/2% |
| rock | 50 | 0.909 | 0.694 | 88% | 2%/8% |

## gtzan-vocals-dev

| set | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| all | 358 | 0.443 | 0.228 | 35% | 4%/16% |

### gtzan-vocals-dev by genre

| genre | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| blues | 41 | 0.362 | 0.183 | 32% | 0%/7% |
| classical | 4 | 0.203 | 0.092 | 25% | 0%/25% |
| country | 47 | 0.395 | 0.236 | 36% | 9%/2% |
| disco | 42 | 0.548 | 0.319 | 71% | 2%/12% |
| hiphop | 47 | 0.490 | 0.202 | 21% | 0%/28% |
| jazz | 11 | 0.280 | 0.171 | 18% | 0%/9% |
| metal | 30 | 0.422 | 0.219 | 47% | 7%/0% |
| pop | 49 | 0.529 | 0.238 | 31% | 0%/33% |
| reggae | 40 | 0.436 | 0.245 | 20% | 15%/12% |
| rock | 47 | 0.410 | 0.210 | 34% | 6%/23% |

## r2-dev

| set | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| all | 590 | 0.471 | 0.222 | 22% | 2%/27% |

### r2-dev by lead

| lead | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| breathy | 42 | 0.447 | 0.192 | 14% | 0%/26% |
| instrument | 138 | 0.485 | 0.253 | 25% | 1%/32% |
| voice | 410 | 0.469 | 0.214 | 22% | 2%/26% |

### r2-dev by lead_group

| lead_group | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| bass | 27 | 0.450 | 0.257 | 33% | 4%/30% |
| breathy | 42 | 0.447 | 0.192 | 14% | 0%/26% |
| guitar | 32 | 0.552 | 0.287 | 28% | 0%/28% |
| keys | 20 | 0.480 | 0.260 | 20% | 0%/40% |
| soulx | 223 | 0.475 | 0.213 | 16% | 2%/31% |
| strings_brass | 25 | 0.439 | 0.204 | 24% | 0%/28% |
| synth | 34 | 0.487 | 0.250 | 18% | 3%/35% |
| vocal_sample | 17 | 0.497 | 0.297 | 29% | 0%/18% |
| voice | 170 | 0.459 | 0.208 | 29% | 2%/21% |

### r2-dev by timing

| timing | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| perfect | 62 | 0.462 | 0.227 | 27% | 2%/32% |
| real | 528 | 0.473 | 0.221 | 22% | 2%/27% |

### r2-dev by meter

| meter | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| 2/4 | 84 | 0.435 | 0.278 | 21% | 2%/25% |
| 3/4 | 120 | 0.491 | 0.209 | 20% | 2%/31% |
| 4/4 | 334 | 0.463 | 0.197 | 21% | 1%/31% |
| 6/8 | 52 | 0.543 | 0.320 | 38% | 2%/0% |

### r2-dev by tempo_band

| tempo_band | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| 120-150 | 60 | 0.415 | 0.229 | 28% | 0%/7% |
| 150-200 | 61 | 0.382 | 0.148 | 16% | 16%/7% |
| 60-90 | 213 | 0.521 | 0.237 | 18% | 0%/42% |
| 90-120 | 256 | 0.465 | 0.225 | 25% | 0%/25% |

### r2-dev by pollution

| pollution | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| heavy | 144 | 0.428 | 0.189 | 13% | 3%/31% |
| light | 175 | 0.496 | 0.230 | 25% | 2%/31% |
| medium | 177 | 0.461 | 0.211 | 28% | 1%/22% |
| none | 94 | 0.513 | 0.277 | 21% | 0%/27% |

### r2-dev by style

| style | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| straight | 380 | 0.481 | 0.232 | 20% | 1%/31% |
| swung | 71 | 0.511 | 0.229 | 38% | 4%/8% |
| syncopated | 139 | 0.425 | 0.191 | 20% | 3%/29% |

### r2-dev by start

| start | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| downbeat | 191 | 0.488 | 0.269 | 23% | 0%/28% |
| midbar | 168 | 0.412 | 0.178 | 18% | 3%/27% |
| pickup | 231 | 0.501 | 0.215 | 25% | 2%/27% |

### r2-dev by bars

| bars | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| 2.0 | 191 | 0.462 | 0.200 | 22% | 3%/24% |
| 4.0 | 197 | 0.471 | 0.226 | 20% | 2%/29% |
| 8.0 | 202 | 0.481 | 0.238 | 24% | 1%/30% |

## r2b-dev

| set | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| all | 593 | 0.507 | 0.254 | 34% | 1%/16% |

### r2b-dev by lead

| lead | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| breathy | 42 | 0.461 | 0.229 | 33% | 0%/12% |
| instrument | 138 | 0.552 | 0.277 | 40% | 1%/17% |
| voice | 413 | 0.496 | 0.248 | 32% | 1%/17% |

### r2b-dev by lead_group

| lead_group | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| bass | 27 | 0.569 | 0.307 | 37% | 7%/30% |
| breathy | 42 | 0.461 | 0.229 | 33% | 0%/12% |
| guitar | 32 | 0.555 | 0.269 | 47% | 0%/6% |
| keys | 20 | 0.579 | 0.320 | 30% | 0%/15% |
| soulx | 226 | 0.494 | 0.243 | 32% | 1%/16% |
| strings_brass | 25 | 0.486 | 0.224 | 36% | 0%/8% |
| synth | 34 | 0.569 | 0.273 | 44% | 0%/24% |
| vocal_sample | 17 | 0.597 | 0.275 | 47% | 0%/18% |
| voice | 170 | 0.489 | 0.252 | 31% | 1%/17% |

### r2b-dev by timing

| timing | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| perfect | 63 | 0.487 | 0.252 | 29% | 0%/16% |
| real | 530 | 0.509 | 0.254 | 35% | 1%/16% |

### r2b-dev by meter

| meter | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| 2/4 | 84 | 0.550 | 0.350 | 40% | 1%/14% |
| 3/4 | 124 | 0.522 | 0.252 | 31% | 1%/16% |
| 4/4 | 334 | 0.498 | 0.212 | 34% | 1%/19% |
| 6/8 | 51 | 0.454 | 0.371 | 25% | 0%/0% |

### r2b-dev by tempo_band

| tempo_band | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| 120-150 | 59 | 0.438 | 0.252 | 41% | 2%/0% |
| 150-200 | 66 | 0.465 | 0.216 | 23% | 8%/3% |
| 60-90 | 214 | 0.539 | 0.257 | 29% | 0%/28% |
| 90-120 | 254 | 0.506 | 0.261 | 39% | 0%/14% |

### r2b-dev by pollution

| pollution | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| heavy | 142 | 0.469 | 0.225 | 27% | 1%/18% |
| light | 179 | 0.536 | 0.287 | 37% | 1%/19% |
| medium | 179 | 0.510 | 0.244 | 38% | 0%/14% |
| none | 93 | 0.501 | 0.250 | 31% | 2%/13% |

### r2b-dev by style

| style | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| straight | 383 | 0.528 | 0.265 | 34% | 1%/19% |
| swung | 72 | 0.557 | 0.293 | 50% | 1%/3% |
| syncopated | 138 | 0.421 | 0.200 | 25% | 1%/16% |

### r2b-dev by start

| start | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| downbeat | 190 | 0.513 | 0.302 | 36% | 1%/15% |
| midbar | 173 | 0.475 | 0.204 | 27% | 1%/17% |
| pickup | 230 | 0.525 | 0.251 | 37% | 2%/17% |

### r2b-dev by bars

| bars | clips | beat F G-r2b-initweights | downbeat F G-r2b-initweights | tempo ok G-r2b-initweights | half/double G-r2b-initweights |
|---|---|---|---|---|---|
| 2.0 | 191 | 0.471 | 0.225 | 31% | 1%/13% |
| 4.0 | 197 | 0.520 | 0.256 | 33% | 1%/20% |
| 8.0 | 205 | 0.528 | 0.277 | 37% | 1%/16% |
