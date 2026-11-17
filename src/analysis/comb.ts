import { spectrogram } from "./fft.ts";

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Pitch of a harmonic sound by a harmonic comb on the spectrum: reward energy at multiples of the
 * candidate, penalise energy halfway between them (which a candidate an octave too low would
 * skip over). Used to MEASURE rendered calls, independently of the YIN tracker the app uses on
 * people; YIN locks onto the second harmonic when a pet's first formant sits on it. Also the
 * pitch tracker for recordings of real pets (analysis/petsound.ts).
 */
export function combPitch(x: Float32Array, fs: number, fMin: number, fMax: number, hopS = 0.01): { f0: number; level: number }[] {
  // 43 ms window: short enough to follow a falling phrase end
  const n = 2048;
  const hop = Math.round(hopS * fs);
  const spec = spectrogram(x, n, hop);
  const out: { f0: number; level: number }[] = [];
  const binHz = fs / n;
  for (const row of spec) {
    const mag = (hz: number) => {
      const b = hz / binHz;
      const i = Math.floor(b);
      if (i + 1 >= row.length) return 0;
      const u = b - i;
      return Math.pow(10, (row[i] * (1 - u) + row[i + 1] * u) / 20);
    };
    let best = 0;
    let bestF = 0;
    let total = 0;
    for (let i = 0; i < row.length; i++) total += Math.pow(10, row[i] / 20);
    for (let f = fMin; f <= fMax; f *= 1.0145) {
      let s = 0;
      for (let h = 1; h <= 8 && h * f < fs / 2; h++) s += (mag(h * f) - mag((h - 0.5) * f)) / Math.sqrt(h);
      if (s > best) {
        best = s;
        bestF = f;
      }
    }
    out.push({ f0: bestF, level: total / row.length });
  }
  // Octave slips (a pet's second harmonic often sits on its first formant and outweighs the
  // fundamental): starting from the loud frames' median, keep each frame within half an octave of
  // the one before by trying f/2 and 2f. Then a 5-frame median.
  const peak = Math.max(...out.map((o) => o.level));
  const loud = out.filter((o) => o.level > peak * 0.2).map((o) => o.f0);
  let prev = median(loud) || fMin;
  for (const o of out) {
    if (o.level < peak * 0.05) continue;
    let best = o.f0;
    for (const c of [o.f0 / 2, o.f0, o.f0 * 2]) if (Math.abs(Math.log2(c / prev)) < Math.abs(Math.log2(best / prev))) best = c;
    o.f0 = best;
    prev = best;
  }
  const raw = out.map((o) => o.f0);
  for (let i = 0; i < out.length; i++) out[i].f0 = median(raw.slice(Math.max(0, i - 2), i + 3));
  return out;
}
