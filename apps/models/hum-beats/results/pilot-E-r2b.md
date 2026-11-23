# Scores (same files for every model)

Beat and downbeat F-measure: mir_eval, 70 ms window, mean over clips, nothing trimmed. Tempo ok: the median predicted beat interval is within 4% of the labelled one (hum-lab: of the meant tempo); half/double: within 4% of half or double.


## dev-humtrans

| set | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| all | 149 | 0.659 | 0.322 | 38% | 0%/42% |

### dev-humtrans by tempo_band

| tempo_band | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| 120-150 | 9 | 0.798 | 0.434 | 78% | 0%/11% |
| 150-200 | 5 | 0.865 | 0.456 | 100% | 0%/0% |
| 60-90 | 67 | 0.574 | 0.275 | 22% | 0%/55% |
| 90-120 | 68 | 0.709 | 0.344 | 43% | 0%/35% |

### dev-humtrans by singer

| singer | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| F01 | 11 | 0.626 | 0.280 | 18% | 0%/64% |
| F02 | 17 | 0.651 | 0.323 | 24% | 0%/53% |
| F03 | 12 | 0.631 | 0.276 | 42% | 0%/25% |
| F04 | 12 | 0.690 | 0.344 | 67% | 0%/25% |
| F05 | 19 | 0.675 | 0.332 | 53% | 0%/37% |
| M01 | 13 | 0.635 | 0.332 | 23% | 0%/31% |
| M02 | 13 | 0.623 | 0.287 | 46% | 0%/23% |
| M03 | 19 | 0.669 | 0.370 | 37% | 0%/42% |
| M04 | 20 | 0.668 | 0.313 | 45% | 0%/40% |
| M05 | 13 | 0.704 | 0.331 | 15% | 0%/77% |

## gtzan-mix-dev

| set | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| all | 498 | 0.869 | 0.676 | 75% | 6%/9% |

### gtzan-mix-dev by genre

| genre | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| blues | 50 | 0.790 | 0.551 | 58% | 0%/16% |
| classical | 50 | 0.651 | 0.446 | 50% | 10%/8% |
| country | 50 | 0.925 | 0.840 | 86% | 8%/4% |
| disco | 50 | 0.986 | 0.856 | 98% | 2%/0% |
| hiphop | 50 | 0.916 | 0.750 | 80% | 0%/12% |
| jazz | 49 | 0.807 | 0.545 | 65% | 6%/8% |
| metal | 50 | 0.865 | 0.620 | 66% | 4%/12% |
| pop | 50 | 0.949 | 0.813 | 90% | 2%/6% |
| reggae | 49 | 0.906 | 0.632 | 76% | 22%/2% |
| rock | 50 | 0.898 | 0.692 | 78% | 2%/18% |

## gtzan-vocals-dev

| set | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| all | 358 | 0.485 | 0.224 | 22% | 1%/20% |

### gtzan-vocals-dev by genre

| genre | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| blues | 41 | 0.417 | 0.178 | 17% | 0%/20% |
| classical | 4 | 0.259 | 0.151 | 0% | 0%/0% |
| country | 47 | 0.471 | 0.238 | 21% | 2%/15% |
| disco | 42 | 0.582 | 0.295 | 43% | 0%/21% |
| hiphop | 47 | 0.489 | 0.196 | 11% | 0%/26% |
| jazz | 11 | 0.316 | 0.174 | 0% | 0%/9% |
| metal | 30 | 0.488 | 0.223 | 20% | 3%/0% |
| pop | 49 | 0.541 | 0.224 | 18% | 0%/39% |
| reggae | 40 | 0.488 | 0.251 | 22% | 5%/12% |
| rock | 47 | 0.461 | 0.211 | 28% | 2%/26% |

## r2-dev

| set | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| all | 590 | 0.470 | 0.215 | 11% | 0%/39% |

### r2-dev by lead

| lead | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| breathy | 42 | 0.447 | 0.192 | 5% | 0%/38% |
| instrument | 138 | 0.497 | 0.236 | 12% | 0%/44% |
| voice | 410 | 0.463 | 0.211 | 11% | 0%/37% |

### r2-dev by lead_group

| lead_group | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| bass | 27 | 0.473 | 0.226 | 11% | 0%/48% |
| breathy | 42 | 0.447 | 0.192 | 5% | 0%/38% |
| guitar | 32 | 0.544 | 0.264 | 16% | 0%/44% |
| keys | 20 | 0.506 | 0.251 | 5% | 0%/60% |
| soulx | 223 | 0.466 | 0.212 | 9% | 0%/39% |
| strings_brass | 25 | 0.462 | 0.196 | 20% | 0%/32% |
| synth | 34 | 0.494 | 0.239 | 6% | 0%/41% |
| vocal_sample | 17 | 0.466 | 0.238 | 12% | 0%/35% |
| voice | 170 | 0.457 | 0.206 | 14% | 1%/35% |

### r2-dev by timing

| timing | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| perfect | 62 | 0.463 | 0.223 | 15% | 0%/45% |
| real | 528 | 0.470 | 0.214 | 10% | 0%/38% |

### r2-dev by meter

| meter | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| 2/4 | 84 | 0.423 | 0.289 | 7% | 0%/44% |
| 3/4 | 120 | 0.485 | 0.222 | 6% | 0%/43% |
| 4/4 | 334 | 0.469 | 0.180 | 9% | 0%/42% |
| 6/8 | 52 | 0.514 | 0.306 | 35% | 0%/0% |

### r2-dev by tempo_band

| tempo_band | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| 120-150 | 60 | 0.444 | 0.237 | 15% | 0%/22% |
| 150-200 | 61 | 0.443 | 0.181 | 7% | 2%/11% |
| 60-90 | 213 | 0.494 | 0.217 | 8% | 0%/52% |
| 90-120 | 256 | 0.462 | 0.217 | 13% | 0%/39% |

### r2-dev by pollution

| pollution | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| heavy | 144 | 0.426 | 0.198 | 9% | 1%/42% |
| light | 175 | 0.488 | 0.219 | 10% | 0%/39% |
| medium | 177 | 0.459 | 0.206 | 14% | 0%/34% |
| none | 94 | 0.523 | 0.252 | 6% | 0%/40% |

### r2-dev by style

| style | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| straight | 380 | 0.475 | 0.216 | 9% | 0%/44% |
| swung | 71 | 0.502 | 0.242 | 20% | 1%/15% |
| syncopated | 139 | 0.438 | 0.198 | 11% | 0%/37% |

### r2-dev by start

| start | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| downbeat | 191 | 0.483 | 0.245 | 10% | 0%/42% |
| midbar | 168 | 0.430 | 0.170 | 10% | 0%/38% |
| pickup | 231 | 0.487 | 0.224 | 12% | 0%/36% |

### r2-dev by bars

| bars | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| 2.0 | 191 | 0.442 | 0.195 | 10% | 0%/37% |
| 4.0 | 197 | 0.465 | 0.207 | 10% | 0%/42% |
| 8.0 | 202 | 0.500 | 0.242 | 11% | 0%/38% |

## r2b-dev

| set | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| all | 593 | 0.510 | 0.248 | 21% | 0%/30% |

### r2b-dev by lead

| lead | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| breathy | 42 | 0.461 | 0.214 | 19% | 0%/17% |
| instrument | 138 | 0.552 | 0.267 | 26% | 0%/29% |
| voice | 413 | 0.501 | 0.245 | 20% | 0%/31% |

### r2b-dev by lead_group

| lead_group | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| bass | 27 | 0.547 | 0.289 | 26% | 0%/44% |
| breathy | 42 | 0.461 | 0.214 | 19% | 0%/17% |
| guitar | 32 | 0.575 | 0.255 | 31% | 0%/25% |
| keys | 20 | 0.579 | 0.297 | 25% | 0%/25% |
| soulx | 226 | 0.496 | 0.240 | 20% | 0%/30% |
| strings_brass | 25 | 0.485 | 0.232 | 16% | 0%/16% |
| synth | 34 | 0.566 | 0.268 | 29% | 0%/32% |
| vocal_sample | 17 | 0.538 | 0.271 | 18% | 0%/53% |
| voice | 170 | 0.503 | 0.249 | 20% | 0%/32% |

### r2b-dev by timing

| timing | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| perfect | 63 | 0.517 | 0.244 | 14% | 0%/43% |
| real | 530 | 0.509 | 0.248 | 22% | 0%/28% |

### r2b-dev by meter

| meter | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| 2/4 | 84 | 0.529 | 0.357 | 25% | 1%/35% |
| 3/4 | 124 | 0.529 | 0.253 | 23% | 0%/28% |
| 4/4 | 334 | 0.506 | 0.203 | 19% | 0%/33% |
| 6/8 | 51 | 0.456 | 0.352 | 24% | 0%/4% |

### r2b-dev by tempo_band

| tempo_band | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| 120-150 | 59 | 0.484 | 0.263 | 32% | 0%/12% |
| 150-200 | 66 | 0.496 | 0.224 | 21% | 2%/9% |
| 60-90 | 214 | 0.533 | 0.248 | 20% | 0%/43% |
| 90-120 | 254 | 0.500 | 0.251 | 20% | 0%/28% |

### r2b-dev by pollution

| pollution | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| heavy | 142 | 0.465 | 0.225 | 18% | 0%/29% |
| light | 179 | 0.542 | 0.270 | 22% | 1%/33% |
| medium | 179 | 0.513 | 0.236 | 23% | 0%/27% |
| none | 93 | 0.510 | 0.261 | 20% | 0%/30% |

### r2b-dev by style

| style | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| straight | 383 | 0.531 | 0.258 | 22% | 0%/32% |
| swung | 72 | 0.552 | 0.284 | 33% | 0%/12% |
| syncopated | 138 | 0.430 | 0.200 | 12% | 0%/33% |

### r2b-dev by start

| start | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| downbeat | 190 | 0.503 | 0.279 | 23% | 0%/25% |
| midbar | 173 | 0.481 | 0.209 | 16% | 0%/35% |
| pickup | 230 | 0.537 | 0.251 | 24% | 0%/30% |

### r2b-dev by bars

| bars | clips | beat F E-r2b | downbeat F E-r2b | tempo ok E-r2b | half/double E-r2b |
|---|---|---|---|---|---|
| 2.0 | 191 | 0.463 | 0.215 | 18% | 0%/25% |
| 4.0 | 197 | 0.518 | 0.254 | 19% | 1%/34% |
| 8.0 | 205 | 0.546 | 0.273 | 26% | 0%/31% |
