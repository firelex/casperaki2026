# Scores (same files for every model)

Beat and downbeat F-measure: mir_eval, 70 ms window, mean over clips, nothing trimmed. Tempo ok: the median predicted beat interval is within 4% of the labelled one (hum-lab: of the meant tempo); half/double: within 4% of half or double.


## dev-humtrans

| set | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| all | 149 | 0.671 | 0.359 | 42% | 0%/36% |

### dev-humtrans by tempo_band

| tempo_band | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| 120-150 | 9 | 0.799 | 0.462 | 78% | 0%/0% |
| 150-200 | 5 | 0.893 | 0.489 | 100% | 0%/0% |
| 60-90 | 67 | 0.594 | 0.306 | 31% | 0%/46% |
| 90-120 | 68 | 0.714 | 0.388 | 44% | 0%/34% |

### dev-humtrans by singer

| singer | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| F01 | 11 | 0.616 | 0.294 | 18% | 0%/64% |
| F02 | 17 | 0.653 | 0.370 | 41% | 0%/35% |
| F03 | 12 | 0.669 | 0.311 | 42% | 0%/25% |
| F04 | 12 | 0.697 | 0.370 | 58% | 0%/25% |
| F05 | 19 | 0.669 | 0.358 | 47% | 0%/37% |
| M01 | 13 | 0.680 | 0.378 | 46% | 0%/23% |
| M02 | 13 | 0.628 | 0.311 | 31% | 0%/23% |
| M03 | 19 | 0.709 | 0.430 | 58% | 0%/26% |
| M04 | 20 | 0.668 | 0.367 | 45% | 0%/40% |
| M05 | 13 | 0.705 | 0.346 | 23% | 0%/69% |

## gtzan-mix-dev

| set | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| all | 498 | 0.876 | 0.764 | 79% | 9%/5% |

### gtzan-mix-dev by genre

| genre | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| blues | 50 | 0.806 | 0.637 | 64% | 0%/12% |
| classical | 50 | 0.638 | 0.474 | 58% | 12%/6% |
| country | 50 | 0.910 | 0.896 | 80% | 16%/2% |
| disco | 50 | 0.988 | 0.959 | 98% | 2%/0% |
| hiphop | 50 | 0.943 | 0.845 | 90% | 0%/8% |
| jazz | 49 | 0.819 | 0.688 | 73% | 12%/6% |
| metal | 50 | 0.885 | 0.748 | 76% | 6%/4% |
| pop | 50 | 0.975 | 0.962 | 94% | 2%/4% |
| reggae | 49 | 0.868 | 0.618 | 63% | 35%/0% |
| rock | 50 | 0.924 | 0.805 | 90% | 2%/8% |

## gtzan-vocals-dev

| set | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| all | 358 | 0.465 | 0.235 | 26% | 2%/17% |

### gtzan-vocals-dev by genre

| genre | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| blues | 41 | 0.394 | 0.174 | 22% | 0%/10% |
| classical | 4 | 0.264 | 0.118 | 0% | 0%/0% |
| country | 47 | 0.440 | 0.252 | 32% | 2%/9% |
| disco | 42 | 0.558 | 0.332 | 45% | 0%/10% |
| hiphop | 47 | 0.474 | 0.204 | 11% | 0%/36% |
| jazz | 11 | 0.310 | 0.187 | 9% | 0%/0% |
| metal | 30 | 0.466 | 0.221 | 27% | 3%/0% |
| pop | 49 | 0.519 | 0.247 | 24% | 0%/33% |
| reggae | 40 | 0.458 | 0.228 | 20% | 5%/8% |
| rock | 47 | 0.459 | 0.235 | 36% | 4%/26% |

## r2-dev

| set | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| all | 590 | 0.463 | 0.210 | 12% | 1%/35% |

### r2-dev by lead

| lead | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| breathy | 42 | 0.429 | 0.201 | 2% | 2%/31% |
| instrument | 138 | 0.488 | 0.231 | 13% | 0%/41% |
| voice | 410 | 0.458 | 0.204 | 12% | 1%/33% |

### r2-dev by lead_group

| lead_group | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| bass | 27 | 0.442 | 0.213 | 15% | 0%/33% |
| breathy | 42 | 0.429 | 0.201 | 2% | 2%/31% |
| guitar | 32 | 0.558 | 0.287 | 12% | 0%/34% |
| keys | 20 | 0.506 | 0.221 | 0% | 0%/50% |
| soulx | 223 | 0.461 | 0.205 | 10% | 1%/38% |
| strings_brass | 25 | 0.419 | 0.189 | 28% | 0%/40% |
| synth | 34 | 0.499 | 0.230 | 9% | 0%/47% |
| vocal_sample | 17 | 0.488 | 0.262 | 18% | 0%/41% |
| voice | 170 | 0.450 | 0.198 | 14% | 1%/26% |

### r2-dev by timing

| timing | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| perfect | 62 | 0.447 | 0.218 | 15% | 0%/39% |
| real | 528 | 0.465 | 0.209 | 11% | 1%/34% |

### r2-dev by meter

| meter | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| 2/4 | 84 | 0.436 | 0.289 | 13% | 1%/38% |
| 3/4 | 120 | 0.476 | 0.204 | 7% | 1%/40% |
| 4/4 | 334 | 0.460 | 0.180 | 11% | 1%/37% |
| 6/8 | 52 | 0.492 | 0.292 | 23% | 0%/0% |

### r2-dev by tempo_band

| tempo_band | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| 120-150 | 60 | 0.442 | 0.242 | 17% | 0%/18% |
| 150-200 | 61 | 0.420 | 0.181 | 13% | 7%/8% |
| 60-90 | 213 | 0.501 | 0.216 | 9% | 0%/49% |
| 90-120 | 256 | 0.446 | 0.205 | 12% | 0%/33% |

### r2-dev by pollution

| pollution | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| heavy | 144 | 0.423 | 0.189 | 10% | 2%/35% |
| light | 175 | 0.482 | 0.210 | 14% | 1%/34% |
| medium | 177 | 0.451 | 0.208 | 12% | 0%/31% |
| none | 94 | 0.510 | 0.250 | 7% | 0%/43% |

### r2-dev by style

| style | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| straight | 380 | 0.469 | 0.211 | 9% | 1%/37% |
| swung | 71 | 0.501 | 0.229 | 20% | 3%/15% |
| syncopated | 139 | 0.427 | 0.200 | 13% | 0%/38% |

### r2-dev by start

| start | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| downbeat | 191 | 0.481 | 0.238 | 13% | 0%/36% |
| midbar | 168 | 0.414 | 0.172 | 10% | 1%/30% |
| pickup | 231 | 0.483 | 0.215 | 12% | 1%/37% |

### r2-dev by bars

| bars | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| 2.0 | 191 | 0.439 | 0.188 | 13% | 1%/27% |
| 4.0 | 197 | 0.462 | 0.208 | 11% | 0%/39% |
| 8.0 | 202 | 0.486 | 0.234 | 10% | 1%/38% |

## r2b-dev

| set | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| all | 593 | 0.498 | 0.236 | 23% | 1%/24% |

### r2b-dev by lead

| lead | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| breathy | 42 | 0.420 | 0.216 | 19% | 2%/21% |
| instrument | 138 | 0.548 | 0.263 | 32% | 0%/18% |
| voice | 413 | 0.488 | 0.229 | 20% | 1%/26% |

### r2b-dev by lead_group

| lead_group | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| bass | 27 | 0.563 | 0.286 | 33% | 0%/22% |
| breathy | 42 | 0.420 | 0.216 | 19% | 2%/21% |
| guitar | 32 | 0.567 | 0.238 | 31% | 0%/22% |
| keys | 20 | 0.567 | 0.295 | 30% | 0%/25% |
| soulx | 226 | 0.484 | 0.225 | 22% | 2%/24% |
| strings_brass | 25 | 0.509 | 0.231 | 32% | 0%/8% |
| synth | 34 | 0.537 | 0.275 | 32% | 0%/15% |
| vocal_sample | 17 | 0.575 | 0.261 | 12% | 0%/47% |
| voice | 170 | 0.485 | 0.232 | 19% | 1%/26% |

### r2b-dev by timing

| timing | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| perfect | 63 | 0.497 | 0.228 | 17% | 0%/35% |
| real | 530 | 0.498 | 0.237 | 24% | 1%/22% |

### r2b-dev by meter

| meter | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| 2/4 | 84 | 0.516 | 0.347 | 27% | 1%/30% |
| 3/4 | 124 | 0.523 | 0.249 | 27% | 2%/20% |
| 4/4 | 334 | 0.491 | 0.185 | 21% | 1%/27% |
| 6/8 | 51 | 0.448 | 0.357 | 20% | 0%/2% |

### r2b-dev by tempo_band

| tempo_band | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| 120-150 | 59 | 0.475 | 0.232 | 29% | 3%/12% |
| 150-200 | 66 | 0.496 | 0.226 | 29% | 6%/6% |
| 60-90 | 214 | 0.516 | 0.245 | 22% | 0%/38% |
| 90-120 | 254 | 0.487 | 0.233 | 20% | 0%/19% |

### r2b-dev by pollution

| pollution | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| heavy | 142 | 0.455 | 0.215 | 18% | 0%/23% |
| light | 179 | 0.514 | 0.260 | 23% | 2%/26% |
| medium | 179 | 0.501 | 0.220 | 25% | 1%/22% |
| none | 93 | 0.524 | 0.255 | 26% | 1%/25% |

### r2b-dev by style

| style | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| straight | 383 | 0.520 | 0.248 | 23% | 1%/25% |
| swung | 72 | 0.535 | 0.274 | 35% | 1%/12% |
| syncopated | 138 | 0.417 | 0.185 | 15% | 0%/25% |

### r2b-dev by start

| start | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| downbeat | 190 | 0.497 | 0.276 | 21% | 1%/23% |
| midbar | 173 | 0.460 | 0.190 | 21% | 0%/26% |
| pickup | 230 | 0.526 | 0.239 | 26% | 2%/23% |

### r2b-dev by bars

| bars | clips | beat F F-r2b-songs | downbeat F F-r2b-songs | tempo ok F-r2b-songs | half/double F-r2b-songs |
|---|---|---|---|---|---|
| 2.0 | 191 | 0.460 | 0.198 | 19% | 2%/18% |
| 4.0 | 197 | 0.505 | 0.244 | 22% | 1%/27% |
| 8.0 | 205 | 0.526 | 0.265 | 27% | 0%/25% |
