/**
 * Features of a pet call, the same for a real recording and for a render, so the two can be
 * compared number for number: how long, how it starts and ends, where the pitch sits and how it
 * moves, how clean the voice is, and the shape of its spectrum.
 */
import { combPitch } from "../src/analysis/comb.ts";
import { spectrogram } from "../src/analysis/fft.ts";
import { resample } from "../src/analysis/prosody.ts";
import { measurePetSound } from "../src/analysis/petsound.ts";
import { Yin } from "../src/analysis/yin.ts";

export const FS = 24000;
export const BANDS = 24;
export const CONTOUR = 12;

export interface CallFeatures {
  duration: number;
  /** seconds from 10% to 90% of the loudest level, and from 90% back down to 10% */
  attack: number;
  release: number;
  /** share of the call that is voiced */
  voiced: number;
  f0: number;
  /** p10–p90 span of the pitch, semitones */
  f0Range: number;
  /** pitch at CONTOUR points through the voiced part, semitones from the median */
  contour: number[];
  /** median frame-to-frame pitch wobble, cents */
  jitter: number;
  hnr: number;
  /** YIN clarity, median over voiced frames */
  clarity: number;
  /** spectral centroid, Hz */
  centroid: number;
  /** dB per octave of the long-term spectrum between 500 Hz and 8 kHz (negative: darker) */
  tilt: number;
  /** long-term spectrum in BANDS log bands 150 Hz–10 kHz, dB from its own mean */
  bands: number[];
  /** loudness wobble: standard deviation of the level in dB over the loud part */
  levelStd: number;
  tractLen: number;
}

/** Split a recording into calls: runs louder than a floor, at least 60 ms long, gaps under 50 ms bridged. */
export function splitCalls(x: Float32Array, fs: number): Float32Array[] {
  const hop = Math.round(fs * 0.01);
  const n = Math.floor(x.length / hop);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0;
    for (let k = 0; k < hop; k++) a += x[i * hop + k] ** 2;
    rms[i] = Math.sqrt(a / hop);
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const loud = sorted[Math.floor(n * 0.98)] || 0;
  const floor = sorted[Math.floor(n * 0.15)] || 0;
  if (loud < 2e-3) return [];
  const thr = Math.max(loud * 0.12, floor * 3);
  const on = Array.from(rms, (v) => v > thr);
  // bridge short gaps
  for (let i = 0; i < n; ) {
    if (on[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !on[j]) j++;
    if (i > 0 && j < n && j - i < 5) for (let k = i; k < j; k++) on[k] = true;
    i = j;
  }
  const out: Float32Array[] = [];
  for (let i = 0; i < n; ) {
    if (!on[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && on[j]) j++;
    // a call cut off by the clip's edge is not a whole call
    if (j - i >= 6 && i > 2 && j < n - 2) out.push(x.slice(Math.max(0, (i - 3) * hop), Math.min(x.length, (j + 3) * hop)));
    i = j;
  }
  return out;
}

export function features(input: Float32Array, sampleRate: number): CallFeatures | null {
  const x = resample(input, sampleRate, FS);
  if (x.length < FS * 0.08) return null;
  const hop = 240;
  const n = Math.floor(x.length / hop);
  const env: number[] = [];
  for (let i = 0; i < n; i++) {
    let a = 0;
    for (let k = 0; k < hop; k++) a += x[i * hop + k] ** 2;
    env.push(Math.sqrt(a / hop));
  }
  const peak = Math.max(...env);
  if (peak < 1e-4) return null;
  const iPeak = env.indexOf(peak);
  const first = (thr: number) => env.findIndex((v) => v >= thr * peak);
  const last = (thr: number) => env.length - 1 - [...env].reverse().findIndex((v) => v >= thr * peak);
  const active = env.map((v) => v > peak * 0.1);
  const duration = (last(0.1) - first(0.1) + 1) * 0.01;
  const attack = Math.max(0.005, (first(0.9) - first(0.1)) * 0.01);
  const release = Math.max(0.005, (last(0.1) - last(0.9)) * 0.01);
  void iPeak;
  const loudDb = env.filter((v) => v > peak * 0.25).map((v) => 20 * Math.log10(v));
  const mean = loudDb.reduce((a, b) => a + b, 0) / Math.max(1, loudDb.length);
  const levelStd = Math.sqrt(loudDb.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, loudDb.length));

  const yin = new Yin({ sampleRate: FS, fMin: 55, fMax: 2600, threshold: 0.15 });
  const comb = combPitch(x, FS, 55, 2600, 0.01);
  const f0s: number[] = [];
  const clar: number[] = [];
  let act = 0;
  for (let i = 0; i < n; i++) {
    if (!active[i]) continue;
    act++;
    if (i * hop + yin.frameSize > x.length) continue;
    const c = yin.analyse(x, i * hop).clarity;
    if (c > 0.55 && comb[i]?.f0 > 0) {
      f0s.push(comb[i].f0);
      clar.push(c);
    }
  }
  const sorted = [...f0s].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const f0 = q(0.5);
  const contour: number[] = [];
  for (let k = 0; k < CONTOUR; k++) {
    const v = f0s[Math.min(f0s.length - 1, Math.floor(((k + 0.5) / CONTOUR) * f0s.length))];
    contour.push(v && f0 ? 12 * Math.log2(v / f0) : 0);
  }
  // long-term spectrum
  const spec = spectrogram(x, 1024, 240);
  const acc = new Float64Array(512);
  let cnt = 0;
  spec.forEach((row, i) => {
    if (!active[Math.min(n - 1, i + 2)]) return;
    for (let b = 0; b < 512; b++) acc[b] += Math.pow(10, row[b] / 10);
    cnt++;
  });
  const binHz = FS / 1024;
  const bands: number[] = [];
  for (let b = 0; b < BANDS; b++) {
    const lo = 150 * Math.pow(10000 / 150, b / BANDS);
    const hi = 150 * Math.pow(10000 / 150, (b + 1) / BANDS);
    let p = 0;
    let c = 0;
    for (let i = Math.max(1, Math.floor(lo / binHz)); i < Math.min(512, Math.ceil(hi / binHz)); i++) {
      p += acc[i];
      c++;
    }
    bands.push(10 * Math.log10(p / Math.max(1, c) / Math.max(1, cnt) + 1e-14));
  }
  const bm = bands.reduce((a, b) => a + b, 0) / BANDS;
  let num = 0;
  let den = 0;
  for (let i = 1; i < 512; i++) {
    num += acc[i] * i * binHz;
    den += acc[i];
  }
  // tilt: least-squares slope of band level against log2(frequency), 500 Hz–8 kHz
  const pts: [number, number][] = [];
  for (let b = 0; b < BANDS; b++) {
    const fc = 150 * Math.pow(10000 / 150, (b + 0.5) / BANDS);
    if (fc >= 500 && fc <= 8000) pts.push([Math.log2(fc), bands[b]]);
  }
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const tilt = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  const m = measurePetSound(x, FS);
  return {
    duration,
    attack,
    release,
    voiced: act ? f0s.length / act : 0,
    f0,
    f0Range: f0 ? 12 * Math.log2(q(0.9) / q(0.1)) : 0,
    contour,
    jitter: m.jitter,
    hnr: m.hnr,
    clarity: clar.length ? [...clar].sort((a, b) => a - b)[clar.length >> 1] : 0,
    centroid: num / Math.max(1e-12, den),
    tilt,
    bands: bands.map((v) => v - bm),
    levelStd,
    tractLen: m.tractLen,
  };
}

export function med(v: number[]): number {
  const s = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}
export function quart(v: number[], p: number): number {
  const s = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
}
