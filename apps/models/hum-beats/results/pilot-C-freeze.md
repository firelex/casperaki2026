# Scores (same files for every model)

Beat and downbeat F-measure: mir_eval, 70 ms window, mean over clips, nothing trimmed. Tempo ok: the median predicted beat interval is within 4% of the labelled one (hum-lab: of the meant tempo); half/double: within 4% of half or double.


## dev-humtrans

| set | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| all | 149 | 0.627 | 0.294 | 29% | 0%/40% |

### dev-humtrans by tempo_band

| tempo_band | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| 120-150 | 9 | 0.763 | 0.409 | 56% | 0%/11% |
| 150-200 | 5 | 0.859 | 0.387 | 100% | 0%/0% |
| 60-90 | 67 | 0.560 | 0.246 | 13% | 0%/55% |
| 90-120 | 68 | 0.658 | 0.320 | 35% | 0%/31% |

### dev-humtrans by singer

| singer | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| F01 | 11 | 0.569 | 0.243 | 0% | 0%/82% |
| F02 | 17 | 0.596 | 0.260 | 24% | 0%/47% |
| F03 | 12 | 0.646 | 0.260 | 33% | 0%/33% |
| F04 | 12 | 0.653 | 0.317 | 42% | 0%/8% |
| F05 | 19 | 0.650 | 0.324 | 42% | 0%/37% |
| M01 | 13 | 0.616 | 0.275 | 15% | 0%/38% |
| M02 | 13 | 0.545 | 0.224 | 31% | 0%/31% |
| M03 | 19 | 0.635 | 0.350 | 37% | 0%/21% |
| M04 | 20 | 0.638 | 0.326 | 35% | 0%/40% |
| M05 | 13 | 0.706 | 0.307 | 15% | 0%/69% |

## gtzan-mix-dev

| set | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| all | 498 | 0.857 | 0.647 | 72% | 6%/9% |

### gtzan-mix-dev by genre

| genre | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| blues | 50 | 0.804 | 0.528 | 64% | 0%/16% |
| classical | 50 | 0.651 | 0.458 | 56% | 10%/6% |
| country | 50 | 0.918 | 0.801 | 84% | 10%/0% |
| disco | 50 | 0.967 | 0.848 | 94% | 2%/2% |
| hiphop | 50 | 0.905 | 0.699 | 78% | 0%/14% |
| jazz | 49 | 0.797 | 0.544 | 61% | 10%/4% |
| metal | 50 | 0.826 | 0.570 | 52% | 6%/14% |
| pop | 50 | 0.920 | 0.757 | 80% | 2%/14% |
| reggae | 49 | 0.904 | 0.589 | 76% | 16%/6% |
| rock | 50 | 0.884 | 0.663 | 78% | 2%/14% |

## gtzan-vocals-dev

| set | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| all | 358 | 0.483 | 0.224 | 21% | 2%/20% |

### gtzan-vocals-dev by genre

| genre | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| blues | 41 | 0.418 | 0.178 | 15% | 0%/17% |
| classical | 4 | 0.227 | 0.153 | 0% | 0%/25% |
| country | 47 | 0.466 | 0.233 | 26% | 2%/9% |
| disco | 42 | 0.586 | 0.299 | 40% | 0%/21% |
| hiphop | 47 | 0.471 | 0.199 | 9% | 0%/28% |
| jazz | 11 | 0.323 | 0.170 | 0% | 9%/0% |
| metal | 30 | 0.498 | 0.228 | 23% | 0%/7% |
| pop | 49 | 0.526 | 0.217 | 16% | 0%/39% |
| reggae | 40 | 0.482 | 0.232 | 22% | 5%/12% |
| rock | 47 | 0.483 | 0.225 | 23% | 4%/21% |

## r2-dev

| set | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| all | 590 | 0.458 | 0.203 | 10% | 0%/33% |

### r2-dev by lead

| lead | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| breathy | 42 | 0.414 | 0.186 | 10% | 0%/31% |
| instrument | 138 | 0.491 | 0.226 | 12% | 0%/36% |
| voice | 410 | 0.452 | 0.197 | 10% | 0%/32% |

### r2-dev by lead_group

| lead_group | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| bass | 27 | 0.481 | 0.221 | 7% | 0%/30% |
| breathy | 42 | 0.414 | 0.186 | 10% | 0%/31% |
| guitar | 32 | 0.572 | 0.260 | 16% | 0%/38% |
| keys | 20 | 0.517 | 0.244 | 5% | 0%/40% |
| soulx | 223 | 0.452 | 0.193 | 10% | 0%/37% |
| strings_brass | 25 | 0.393 | 0.162 | 24% | 0%/24% |
| synth | 34 | 0.478 | 0.232 | 9% | 0%/44% |
| vocal_sample | 17 | 0.482 | 0.243 | 18% | 0%/18% |
| voice | 170 | 0.449 | 0.197 | 8% | 1%/28% |

### r2-dev by timing

| timing | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| perfect | 62 | 0.448 | 0.201 | 16% | 0%/35% |
| real | 528 | 0.459 | 0.203 | 10% | 0%/33% |

### r2-dev by meter

| meter | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| 2/4 | 84 | 0.407 | 0.244 | 6% | 0%/39% |
| 3/4 | 120 | 0.475 | 0.206 | 12% | 0%/34% |
| 4/4 | 334 | 0.465 | 0.176 | 8% | 1%/35% |
| 6/8 | 52 | 0.462 | 0.296 | 27% | 0%/4% |

### r2-dev by tempo_band

| tempo_band | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| 120-150 | 60 | 0.427 | 0.238 | 13% | 0%/20% |
| 150-200 | 61 | 0.429 | 0.179 | 13% | 3%/10% |
| 60-90 | 213 | 0.492 | 0.209 | 8% | 0%/41% |
| 90-120 | 256 | 0.445 | 0.194 | 11% | 0%/34% |

### r2-dev by pollution

| pollution | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| heavy | 144 | 0.407 | 0.180 | 10% | 1%/31% |
| light | 175 | 0.476 | 0.207 | 11% | 1%/35% |
| medium | 177 | 0.454 | 0.191 | 11% | 0%/32% |
| none | 94 | 0.512 | 0.251 | 9% | 0%/33% |

### r2-dev by style

| style | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| straight | 380 | 0.463 | 0.203 | 9% | 0%/34% |
| swung | 71 | 0.473 | 0.215 | 14% | 3%/15% |
| syncopated | 139 | 0.439 | 0.196 | 12% | 0%/37% |

### r2-dev by start

| start | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| downbeat | 191 | 0.464 | 0.234 | 12% | 0%/34% |
| midbar | 168 | 0.426 | 0.160 | 7% | 0%/32% |
| pickup | 231 | 0.477 | 0.208 | 12% | 1%/32% |

### r2-dev by bars

| bars | clips | beat F C-freeze | downbeat F C-freeze | tempo ok C-freeze | half/double C-freeze |
|---|---|---|---|---|---|
| 2.0 | 191 | 0.428 | 0.181 | 13% | 1%/26% |
| 4.0 | 197 | 0.457 | 0.191 | 10% | 0%/32% |
| 8.0 | 202 | 0.488 | 0.234 | 8% | 0%/40% |
