# Scores (same files for every model)

Beat and downbeat F-measure: mir_eval, 70 ms window, mean over clips, nothing trimmed. Tempo ok: the median predicted beat interval is within 4% of the labelled one (hum-lab: of the meant tempo); half/double: within 4% of half or double.


## dev

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| all | 1000 | 0.315 | 0.166 | 18% | 6%/6% | 0.532 | 0.293 | 36% | 5%/4% |

### dev by lead

| lead | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| breathy | 108 | 0.130 | 0.066 | 4% | 2%/4% | 0.491 | 0.252 | 37% | 5%/4% |
| instrument | 397 | 0.427 | 0.201 | 27% | 6%/9% | 0.562 | 0.297 | 40% | 5%/7% |
| voice | 495 | 0.266 | 0.160 | 14% | 6%/5% | 0.517 | 0.299 | 34% | 6%/2% |

### dev by lead_group

| lead_group | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| bass | 77 | 0.364 | 0.135 | 22% | 4%/10% | 0.508 | 0.249 | 36% | 9%/6% |
| breathy | 108 | 0.130 | 0.066 | 4% | 2%/4% | 0.491 | 0.252 | 37% | 5%/4% |
| guitar | 77 | 0.477 | 0.240 | 32% | 6%/9% | 0.587 | 0.307 | 32% | 4%/10% |
| keys | 99 | 0.432 | 0.192 | 28% | 6%/7% | 0.550 | 0.284 | 43% | 3%/4% |
| strings_brass | 75 | 0.427 | 0.227 | 25% | 7%/11% | 0.578 | 0.331 | 43% | 5%/5% |
| synth | 69 | 0.435 | 0.216 | 28% | 7%/6% | 0.595 | 0.323 | 43% | 3%/10% |
| vocal_sample | 47 | 0.277 | 0.156 | 13% | 2%/9% | 0.631 | 0.332 | 43% | 2%/0% |
| voice | 448 | 0.265 | 0.160 | 14% | 6%/4% | 0.504 | 0.295 | 33% | 6%/2% |

### dev by timing

| timing | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| humanised | 435 | 0.316 | 0.161 | 20% | 5%/7% | 0.544 | 0.294 | 39% | 5%/5% |
| irregular | 312 | 0.295 | 0.155 | 13% | 5%/5% | 0.495 | 0.271 | 27% | 4%/3% |
| perfect | 253 | 0.340 | 0.188 | 20% | 8%/6% | 0.557 | 0.319 | 44% | 6%/4% |

### dev by meter

| meter | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| 3/4 | 345 | 0.352 | 0.173 | 23% | 6%/9% | 0.588 | 0.299 | 42% | 5%/7% |
| 4/4 | 334 | 0.344 | 0.168 | 21% | 7%/9% | 0.535 | 0.260 | 38% | 5%/5% |
| 6/8 | 321 | 0.246 | 0.156 | 9% | 4%/0% | 0.468 | 0.322 | 29% | 6%/0% |

### dev by tempo_band

| tempo_band | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| 120-150 | 198 | 0.318 | 0.180 | 22% | 8%/1% | 0.502 | 0.301 | 37% | 8%/2% |
| 150-200 | 359 | 0.235 | 0.137 | 9% | 8%/1% | 0.458 | 0.255 | 19% | 10%/3% |
| 60-90 | 229 | 0.379 | 0.189 | 19% | 2%/20% | 0.640 | 0.331 | 55% | 0%/9% |
| 90-120 | 214 | 0.378 | 0.178 | 29% | 2%/7% | 0.568 | 0.310 | 44% | 1%/4% |

### dev by pollution

| pollution | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| heavy | 254 | 0.242 | 0.135 | 12% | 6%/6% | 0.473 | 0.243 | 34% | 4%/2% |
| light | 274 | 0.315 | 0.160 | 19% | 6%/5% | 0.547 | 0.309 | 41% | 7%/3% |
| medium | 309 | 0.333 | 0.167 | 21% | 5%/7% | 0.544 | 0.299 | 36% | 5%/6% |
| none | 163 | 0.396 | 0.221 | 21% | 6%/6% | 0.576 | 0.333 | 34% | 5%/4% |

### dev by style

| style | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| straight | 388 | 0.339 | 0.172 | 19% | 7%/7% | 0.559 | 0.327 | 38% | 7%/5% |
| swung | 220 | 0.397 | 0.196 | 28% | 5%/2% | 0.655 | 0.319 | 54% | 5%/0% |
| syncopated | 392 | 0.246 | 0.143 | 11% | 5%/7% | 0.436 | 0.245 | 25% | 4%/6% |

### dev by start

| start | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| downbeat | 304 | 0.327 | 0.211 | 15% | 8%/7% | 0.561 | 0.356 | 35% | 5%/7% |
| midbar | 276 | 0.302 | 0.142 | 17% | 3%/6% | 0.500 | 0.251 | 38% | 6%/3% |
| pickup | 420 | 0.315 | 0.149 | 21% | 5%/6% | 0.532 | 0.275 | 37% | 5%/3% |

### dev by bars

| bars | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| 2.0 | 311 | 0.247 | 0.134 | 11% | 3%/5% | 0.499 | 0.256 | 34% | 3%/3% |
| 4.0 | 339 | 0.316 | 0.176 | 17% | 8%/8% | 0.528 | 0.312 | 35% | 6%/5% |
| 8.0 | 350 | 0.375 | 0.184 | 26% | 6%/5% | 0.565 | 0.308 | 41% | 7%/4% |

## test

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| all | 1000 | 0.324 | 0.163 | 21% | 4%/5% | 0.528 | 0.296 | 35% | 7%/4% |

### test by lead

| lead | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| breathy | 128 | 0.126 | 0.069 | 6% | 2%/2% | 0.507 | 0.294 | 34% | 11%/1% |
| instrument | 407 | 0.423 | 0.208 | 30% | 5%/7% | 0.554 | 0.310 | 40% | 5%/5% |
| voice | 465 | 0.292 | 0.149 | 17% | 4%/5% | 0.511 | 0.284 | 32% | 9%/3% |

### test by lead_group

| lead_group | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| bass | 79 | 0.392 | 0.211 | 25% | 4%/4% | 0.516 | 0.289 | 39% | 5%/5% |
| breathy | 128 | 0.126 | 0.069 | 6% | 2%/2% | 0.507 | 0.294 | 34% | 11%/1% |
| guitar | 92 | 0.424 | 0.210 | 27% | 7%/11% | 0.583 | 0.318 | 43% | 9%/5% |
| keys | 70 | 0.417 | 0.200 | 37% | 7%/4% | 0.572 | 0.314 | 39% | 1%/7% |
| strings_brass | 79 | 0.413 | 0.207 | 25% | 4%/9% | 0.532 | 0.335 | 35% | 4%/4% |
| synth | 87 | 0.464 | 0.210 | 37% | 3%/6% | 0.564 | 0.294 | 44% | 3%/6% |
| vocal_sample | 49 | 0.415 | 0.177 | 35% | 8%/10% | 0.597 | 0.327 | 41% | 10%/6% |
| voice | 416 | 0.278 | 0.145 | 15% | 4%/4% | 0.500 | 0.279 | 31% | 8%/3% |

### test by timing

| timing | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| humanised | 432 | 0.336 | 0.167 | 24% | 4%/6% | 0.526 | 0.289 | 35% | 8%/5% |
| irregular | 297 | 0.278 | 0.146 | 15% | 4%/4% | 0.492 | 0.277 | 30% | 6%/1% |
| perfect | 271 | 0.357 | 0.174 | 24% | 4%/6% | 0.571 | 0.328 | 43% | 7%/5% |

### test by meter

| meter | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| 3/4 | 319 | 0.333 | 0.151 | 20% | 4%/9% | 0.544 | 0.284 | 35% | 7%/5% |
| 4/4 | 334 | 0.368 | 0.179 | 28% | 5%/7% | 0.557 | 0.273 | 40% | 8%/5% |
| 6/8 | 347 | 0.274 | 0.157 | 16% | 3%/0% | 0.486 | 0.329 | 31% | 7%/1% |

### test by tempo_band

| tempo_band | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| 120-150 | 223 | 0.352 | 0.161 | 27% | 3%/2% | 0.512 | 0.294 | 36% | 5%/3% |
| 150-200 | 330 | 0.240 | 0.130 | 11% | 10%/1% | 0.468 | 0.264 | 21% | 18%/1% |
| 60-90 | 222 | 0.389 | 0.197 | 19% | 0%/18% | 0.627 | 0.333 | 49% | 0%/8% |
| 90-120 | 225 | 0.357 | 0.177 | 32% | 0%/4% | 0.534 | 0.308 | 43% | 1%/4% |

### test by pollution

| pollution | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| heavy | 235 | 0.267 | 0.122 | 17% | 4%/6% | 0.464 | 0.252 | 33% | 7%/4% |
| light | 330 | 0.369 | 0.177 | 25% | 4%/5% | 0.555 | 0.309 | 37% | 7%/4% |
| medium | 301 | 0.281 | 0.147 | 18% | 4%/5% | 0.520 | 0.286 | 35% | 8%/4% |
| none | 134 | 0.413 | 0.233 | 25% | 5%/5% | 0.594 | 0.363 | 38% | 7%/4% |

### test by style

| style | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| straight | 368 | 0.342 | 0.177 | 20% | 4%/5% | 0.564 | 0.340 | 39% | 9%/4% |
| swung | 228 | 0.409 | 0.178 | 32% | 6%/0% | 0.610 | 0.298 | 48% | 7%/2% |
| syncopated | 404 | 0.260 | 0.141 | 17% | 3%/9% | 0.449 | 0.255 | 25% | 6%/5% |

### test by start

| start | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| downbeat | 325 | 0.324 | 0.202 | 19% | 4%/5% | 0.517 | 0.321 | 32% | 7%/4% |
| midbar | 285 | 0.327 | 0.157 | 22% | 4%/7% | 0.515 | 0.257 | 37% | 7%/3% |
| pickup | 390 | 0.322 | 0.133 | 22% | 4%/5% | 0.547 | 0.304 | 37% | 8%/4% |

### test by bars

| bars | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| 2.0 | 354 | 0.237 | 0.126 | 12% | 2%/3% | 0.467 | 0.253 | 29% | 7%/4% |
| 4.0 | 320 | 0.353 | 0.166 | 24% | 4%/7% | 0.543 | 0.302 | 35% | 7%/5% |
| 8.0 | 326 | 0.391 | 0.199 | 28% | 7%/7% | 0.580 | 0.337 | 42% | 9%/2% |

## test-unseen

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| all | 500 | 0.324 | 0.152 | 21% | 4%/8% | 0.525 | 0.287 | 31% | 9%/6% |

### test-unseen by lead

| lead | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| breathy | 79 | 0.158 | 0.072 | 13% | 4%/5% | 0.525 | 0.300 | 30% | 8%/5% |
| instrument | 201 | 0.411 | 0.194 | 29% | 3%/11% | 0.570 | 0.299 | 36% | 6%/8% |
| voice | 220 | 0.305 | 0.142 | 17% | 5%/5% | 0.483 | 0.272 | 25% | 12%/4% |

### test-unseen by lead_group

| lead_group | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| bass | 49 | 0.391 | 0.185 | 24% | 2%/14% | 0.523 | 0.296 | 29% | 8%/10% |
| breathy | 79 | 0.158 | 0.072 | 13% | 4%/5% | 0.525 | 0.300 | 30% | 8%/5% |
| guitar | 38 | 0.462 | 0.224 | 32% | 5%/13% | 0.607 | 0.313 | 53% | 3%/8% |
| keys | 38 | 0.421 | 0.177 | 32% | 3%/5% | 0.608 | 0.305 | 42% | 3%/11% |
| strings_brass | 39 | 0.425 | 0.237 | 31% | 3%/15% | 0.594 | 0.287 | 26% | 5%/13% |
| synth | 37 | 0.359 | 0.149 | 27% | 5%/8% | 0.528 | 0.295 | 35% | 14%/0% |
| voice | 220 | 0.305 | 0.142 | 17% | 5%/5% | 0.483 | 0.272 | 25% | 12%/4% |

### test-unseen by timing

| timing | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| humanised | 210 | 0.311 | 0.126 | 22% | 3%/4% | 0.528 | 0.294 | 32% | 7%/5% |
| irregular | 158 | 0.304 | 0.149 | 14% | 2%/11% | 0.490 | 0.249 | 23% | 5%/4% |
| perfect | 132 | 0.370 | 0.196 | 29% | 8%/10% | 0.562 | 0.323 | 36% | 17%/9% |

### test-unseen by meter

| meter | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| 3/4 | 164 | 0.356 | 0.142 | 24% | 4%/11% | 0.563 | 0.272 | 32% | 6%/11% |
| 4/4 | 171 | 0.354 | 0.142 | 22% | 5%/11% | 0.550 | 0.251 | 37% | 10%/5% |
| 6/8 | 165 | 0.262 | 0.172 | 18% | 3%/1% | 0.460 | 0.341 | 23% | 11%/2% |

### test-unseen by tempo_band

| tempo_band | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| 120-150 | 107 | 0.304 | 0.138 | 22% | 7%/5% | 0.522 | 0.278 | 34% | 14%/3% |
| 150-200 | 166 | 0.260 | 0.107 | 13% | 7%/1% | 0.457 | 0.248 | 16% | 16%/2% |
| 60-90 | 121 | 0.380 | 0.184 | 22% | 0%/21% | 0.629 | 0.336 | 44% | 0%/15% |
| 90-120 | 106 | 0.382 | 0.201 | 32% | 1%/7% | 0.513 | 0.305 | 35% | 3%/4% |

### test-unseen by pollution

| pollution | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| heavy | 124 | 0.207 | 0.097 | 10% | 2%/5% | 0.419 | 0.228 | 19% | 11%/2% |
| light | 156 | 0.353 | 0.152 | 24% | 4%/10% | 0.558 | 0.309 | 32% | 8%/10% |
| medium | 142 | 0.345 | 0.173 | 25% | 5%/8% | 0.532 | 0.289 | 32% | 9%/6% |
| none | 78 | 0.417 | 0.202 | 27% | 4%/6% | 0.614 | 0.338 | 45% | 8%/3% |

### test-unseen by style

| style | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| straight | 198 | 0.327 | 0.167 | 20% | 5%/10% | 0.550 | 0.325 | 31% | 9%/8% |
| swung | 111 | 0.457 | 0.185 | 36% | 5%/2% | 0.644 | 0.311 | 49% | 9%/1% |
| syncopated | 191 | 0.245 | 0.118 | 14% | 3%/9% | 0.429 | 0.234 | 20% | 9%/6% |

### test-unseen by start

| start | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| downbeat | 159 | 0.344 | 0.196 | 19% | 5%/9% | 0.522 | 0.316 | 31% | 9%/6% |
| midbar | 136 | 0.274 | 0.133 | 21% | 4%/3% | 0.495 | 0.259 | 26% | 12%/6% |
| pickup | 205 | 0.343 | 0.130 | 23% | 3%/10% | 0.546 | 0.284 | 33% | 6%/5% |

### test-unseen by bars

| bars | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| 2.0 | 152 | 0.300 | 0.119 | 17% | 1%/7% | 0.488 | 0.247 | 28% | 5%/10% |
| 4.0 | 180 | 0.274 | 0.146 | 17% | 6%/6% | 0.510 | 0.301 | 27% | 11%/3% |
| 8.0 | 168 | 0.401 | 0.189 | 29% | 5%/10% | 0.573 | 0.310 | 37% | 11%/5% |

## test-humtrans

| set | clips | beat F final0 | downbeat F final0 | tempo ok final0 | half/double final0 | beat F finetuned | downbeat F finetuned | tempo ok finetuned | half/double finetuned |
|---|---|---|---|---|---|---|---|---|---|
| all | 296 | 0.556 | 0.352 | 58% | 0%/24% | 0.537 | 0.293 | 54% | 1%/12% |
