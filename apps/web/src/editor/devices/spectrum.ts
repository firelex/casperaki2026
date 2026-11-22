/** Spectrum analysis for the device views: Hann-windowed FFT, power in log-spaced bands. */

export const BANDS = 96;
export const F_LO = 20;
export const F_HI = 20000;

/** Centre frequency of band i. */
export function bandFreq(i: number): number {
  return F_LO * Math.pow(F_HI / F_LO, (i + 0.5) / BANDS);
}

/** In-place radix-2 FFT (re, im of length 2^k). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Power (dB) per log-spaced band of a block of samples (length a power of 2). */
export function bandPowersDb(samples: Float32Array, sampleRate: number): Float32Array {
  const n = samples.length;
  if (n & (n - 1)) throw new Error('bandPowersDb: length must be a power of 2');
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = samples[i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  fft(re, im);
  const out = new Float32Array(BANDS);
  const binHz = sampleRate / n;
  for (let b = 0; b < BANDS; b++) {
    const lo = F_LO * Math.pow(F_HI / F_LO, b / BANDS);
    const hi = F_LO * Math.pow(F_HI / F_LO, (b + 1) / BANDS);
    let k0 = Math.floor(lo / binHz);
    let k1 = Math.ceil(hi / binHz);
    k0 = Math.max(1, k0);
    k1 = Math.min(n / 2 - 1, Math.max(k0, k1));
    let sum = 0;
    for (let k = k0; k <= k1; k++) sum += re[k]! * re[k]! + im[k]! * im[k]!;
    const power = sum / (k1 - k0 + 1) / (n * n);
    out[b] = power > 1e-20 ? 10 * Math.log10(power) : -200;
  }
  return out;
}
