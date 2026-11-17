/** In-place radix-2 FFT and a dB spectrogram. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** Magnitude spectrogram in dB: frames × (n/2) bins (Hann window). */
export function spectrogram(x: Float32Array, n = 1024, hop = 256): Float32Array[] {
  const out: Float32Array[] = [];
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let s = 0; s + n <= x.length; s += hop) {
    for (let i = 0; i < n; i++) {
      re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
      im[i] = 0;
    }
    fft(re, im);
    const row = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) row[i] = 10 * Math.log10(re[i] * re[i] + im[i] * im[i] + 1e-12);
    out.push(row);
  }
  return out;
}
