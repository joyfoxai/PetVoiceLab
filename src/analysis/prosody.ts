/**
 * Prosody from a voice: pitch contour, loudness envelope, pauses and syllable rhythm. No words are
 * recognised. Streaming: feed microphone blocks as they arrive and read `frames` for a live curve;
 * `finish()` cleans the contour up and finds the syllables.
 *
 * Everything runs locally at 16 kHz with a 10 ms hop: YIN for pitch (yin.ts), RMS for loudness.
 */
import { combPitch } from "./comb.ts";
import { Yin, type PitchFrame } from "./yin.ts";

export const PROSODY_RATE = 16000;
export const HOP_S = 0.01;
const HOP = PROSODY_RATE * HOP_S;

export interface Syllable {
  /** seconds */
  t0: number;
  t1: number;
  /** time of the loudest point */
  peak: number;
  /** loudness at the peak, 0..1 of the recording's loudest */
  level: number;
}

export interface Prosody {
  /** seconds per frame */
  hop: number;
  duration: number;
  /** Hz per frame, 0 where unvoiced or silent */
  f0: Float32Array;
  /** loudness per frame, 0..1 of the loudest frame (smoothed RMS) */
  energy: Float32Array;
  /** 1 where the speaker is making sound (voiced or not), 0 in pauses */
  active: Uint8Array;
  syllables: Syllable[];
  /** median pitch of the voiced frames, Hz (0 if none) */
  medianF0: number;
  /** how periodic each frame is, 0 noise … 1 clean (only where the analyser provides it) */
  clarity?: Float32Array;
}

/** Linear-phase low-pass + resampler to 16 kHz for arbitrary input rates (windowed sinc). */
export class Resampler {
  private readonly ratio: number;
  private readonly taps: Float32Array;
  private readonly half: number;
  private buf: Float32Array;
  private len = 0;
  /** position of the next output sample, in input samples relative to buf[0] */
  private pos: number;

  constructor(inRate: number, outRate: number) {
    this.ratio = inRate / outRate;
    const cutoff = Math.min(1, outRate / inRate) * 0.45; // cycles per input sample
    this.half = Math.ceil(12 * Math.max(1, this.ratio));
    // taps on a 1/32-sample grid for fractional positions
    const n = this.half * 32;
    this.taps = new Float32Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const x = i / 32;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / this.half);
      const s = x === 0 ? 1 : Math.sin(2 * Math.PI * cutoff * x) / (2 * Math.PI * cutoff * x);
      this.taps[i] = 2 * cutoff * s * w;
    }
    this.buf = new Float32Array(8192);
    this.pos = this.half;
  }

  push(x: Float32Array, out: number[]): void {
    if (this.len + x.length > this.buf.length) {
      const nb = new Float32Array(Math.max(this.buf.length * 2, this.len + x.length));
      nb.set(this.buf.subarray(0, this.len));
      this.buf = nb;
    }
    this.buf.set(x, this.len);
    this.len += x.length;
    while (this.pos + this.half < this.len) {
      const c = Math.floor(this.pos);
      const frac = this.pos - c;
      let acc = 0;
      for (let k = -this.half + 1; k <= this.half; k++) {
        const d = Math.abs(k - frac);
        if (d >= this.half) continue;
        acc += this.buf[c + k] * this.taps[Math.round(d * 32)];
      }
      out.push(acc);
      this.pos += this.ratio;
    }
    // drop consumed input
    const keep = Math.max(0, Math.floor(this.pos) - this.half);
    if (keep > 0) {
      this.buf.copyWithin(0, keep, this.len);
      this.len -= keep;
      this.pos -= keep;
    }
  }
}

/** Resample a whole buffer. */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const out: number[] = [];
  new Resampler(from, to).push(x, out);
  return Float32Array.from(out);
}

export class ProsodyAnalyzer {
  /** raw per-hop analysis, appended as audio arrives (for a live curve while recording) */
  readonly frames: PitchFrame[] = [];
  private readonly yin = new Yin({ sampleRate: PROSODY_RATE, fMin: 65, fMax: 520, threshold: 0.15 });
  private readonly resampler: Resampler | null;
  private pending: number[] = [];
  private samples = 0;

  constructor(inputRate: number) {
    this.resampler = inputRate === PROSODY_RATE ? null : new Resampler(inputRate, PROSODY_RATE);
  }

  /** seconds of audio taken in so far */
  get duration(): number {
    return this.samples / PROSODY_RATE;
  }

  push(x: Float32Array): void {
    const before = this.pending.length;
    if (this.resampler) this.resampler.push(x, this.pending);
    else for (let i = 0; i < x.length; i++) this.pending.push(x[i]);
    this.samples += this.pending.length - before;
    const need = this.yin.frameSize;
    if (this.pending.length < need) return;
    const buf = Float32Array.from(this.pending);
    let s = 0;
    for (; s + need <= buf.length; s += HOP) this.frames.push(this.yin.analyse(buf, s));
    this.pending = this.pending.slice(s);
  }

  finish(): Prosody {
    return cleanProsody(this.frames, this.duration);
  }
}

/** Analyse a whole decoded buffer. */
export function analyseProsody(x: Float32Array, sampleRate: number): Prosody {
  const a = new ProsodyAnalyzer(sampleRate);
  const block = 4096;
  for (let i = 0; i < x.length; i += block) a.push(x.subarray(i, Math.min(x.length, i + block)));
  return a.finish();
}

function medianOf(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** Raw frames → a contour without octave jumps or blips, an envelope, pauses and syllables. */
export function cleanProsody(frames: PitchFrame[], duration: number, opts: { wide?: boolean } = {}): Prosody {
  const n = frames.length;
  const f0 = new Float32Array(n);
  const energy = new Float32Array(n);
  const active = new Uint8Array(n);
  if (!n) return { hop: HOP_S, duration, f0, energy, active, syllables: [], medianF0: 0 };

  // loudness: RMS smoothed over ~50 ms, normalised to its 98th percentile
  const raw = frames.map((f) => f.rms);
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0;
    let w = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const g = 3 - Math.abs(k);
      a += raw[j] * g;
      w += g;
    }
    sm[i] = a / w;
  }
  const sorted = Array.from(sm).sort((a, b) => a - b);
  const loud = sorted[Math.min(n - 1, Math.floor(n * 0.98))] || 1e-9;
  const floor = sorted[Math.floor(n * 0.1)];
  // speech is "active" above a threshold between the noise floor and the loud level
  const thr = Math.max(floor * 2.5, loud * 0.07, 2e-4);
  for (let i = 0; i < n; i++) {
    energy[i] = Math.min(1, sm[i] / loud);
    active[i] = sm[i] > thr ? 1 : 0;
  }
  // close gaps < 80 ms (stop closures), drop islands < 40 ms (clicks)
  fillRuns(active, 0, 8);
  fillRuns(active, 1, 4);

  // voicing: periodic enough and active
  for (let i = 0; i < n; i++) f0[i] = active[i] && frames[i].clarity > 0.55 ? frames[i].f0 : 0;
  const voiced: number[] = [];
  for (let i = 0; i < n; i++) if (f0[i] > 0 && frames[i].clarity > 0.8) voiced.push(f0[i]);
  let med = medianOf(voiced.length ? voiced : Array.from(f0).filter((v) => v > 0));
  // octave errors: fold anything more than ~0.8 octave from the median back toward it
  // (not for animals: a call may honestly span more than that, and the caller's pitch tracker
  // has already dealt with octave slips)
  if (med > 0 && !opts.wide) {
    for (let i = 0; i < n; i++) {
      if (!f0[i]) continue;
      while (f0[i] > med * 1.75) f0[i] /= 2;
      while (f0[i] < med / 1.75) f0[i] *= 2;
    }
  }
  // 5-point median over voiced neighbours, then drop voiced islands < 30 ms
  const copy = Float32Array.from(f0);
  for (let i = 0; i < n; i++) {
    if (!copy[i]) continue;
    const w: number[] = [];
    for (let k = -2; k <= 2; k++) if (copy[i + k] > 0) w.push(copy[i + k]);
    f0[i] = medianOf(w);
  }
  const v = new Uint8Array(n);
  for (let i = 0; i < n; i++) v[i] = f0[i] > 0 ? 1 : 0;
  fillRuns(v, 1, 3);
  for (let i = 0; i < n; i++) if (!v[i]) f0[i] = 0;
  med = medianOf(Array.from(f0).filter((x) => x > 0));

  return { hop: HOP_S, duration, f0, energy, active, syllables: findSyllables(energy, active), medianF0: med, clarity: Float32Array.from(frames, (f) => f.clarity) };
}

/** Flip runs of `value` shorter than `minLen` (not touching the ends for value 0). */
function fillRuns(a: Uint8Array, value: 0 | 1, minLen: number): void {
  let i = 0;
  while (i < a.length) {
    if (a[i] !== value) {
      i++;
      continue;
    }
    let j = i;
    while (j < a.length && a[j] === value) j++;
    const inner = value === 1 || (i > 0 && j < a.length);
    if (j - i < minLen && inner) a.fill(value ? 0 : 1, i, j);
    i = j;
  }
}

/**
 * Syllables: peaks of the loudness envelope (smoothed to ~8 Hz, the fastest people speak)
 * separated by dips of at least a quarter of the smaller peak, or by pauses.
 */
function findSyllables(energy: Float32Array, active: Uint8Array): Syllable[] {
  const n = energy.length;
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0;
    let w = 0;
    for (let k = -4; k <= 4; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const g = 5 - Math.abs(k);
      a += energy[j] * g;
      w += g;
    }
    e[i] = active[i] ? a / w : 0;
  }
  const out: Syllable[] = [];
  let i = 0;
  while (i < n) {
    if (!active[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && active[j]) j++;
    // within the phrase [i, j): split at significant dips
    let start = i;
    let peak = i;
    let k = i + 1;
    while (k < j) {
      if (e[k] > e[peak]) peak = k;
      // a dip: local minimum well below the peak before it, followed by a rise
      const isMin = e[k] <= e[k - 1] && (k + 1 >= j || e[k] < e[k + 1]);
      if (isMin && k - peak >= 4 && e[k] < e[peak] * 0.72) {
        // look ahead for the next peak to confirm the rise
        let m = k;
        for (let q = k + 1; q < Math.min(j, k + 40); q++) if (e[q] > e[m]) m = q;
        if (e[m] > e[k] * 1.3 && m - k >= 3) {
          out.push({ t0: start * HOP_S, t1: k * HOP_S, peak: peak * HOP_S, level: e[peak] });
          start = k;
          peak = k;
        }
      }
      k++;
    }
    out.push({ t0: start * HOP_S, t1: j * HOP_S, peak: peak * HOP_S, level: e[peak] });
    i = j;
  }
  return out;
}

/** Semitones the pitch moves over the last `window` seconds of voiced speech (+ rising, − falling). */
export function finalSlope(f0: ArrayLike<number>, hop: number, window = 0.35): number {
  const idx: number[] = [];
  for (let i = f0.length - 1; i >= 0 && idx.length < Math.round(window / hop); i--) if (f0[i] > 0) idx.push(i);
  if (idx.length < 6) return 0;
  idx.reverse();
  const third = Math.max(2, Math.floor(idx.length / 3));
  const mean = (a: number[]) => a.reduce((s, i) => s + Math.log2(f0[i]), 0) / a.length;
  return 12 * (mean(idx.slice(-third)) - mean(idx.slice(0, third)));
}

/**
 * Prosody of an animal's call, for "the pet said this itself". Same output as for a person, but:
 * pitch is searched over 55–2600 Hz with the harmonic comb (a cat's fundamental is often weaker
 * than its second harmonic, which fools YIN), nothing is folded toward the median, and YIN is
 * kept only as the measure of how clean each frame is.
 */
export function analysePetProsody(input: Float32Array, sampleRate: number): Prosody {
  const fs = 24000;
  const hop = fs * HOP_S;
  const x = resample(input, sampleRate, fs);
  const yin = new Yin({ sampleRate: fs, fMin: 55, fMax: 2600, threshold: 0.15 });
  const comb = combPitch(x, fs, 55, 2600, HOP_S);
  const frames: PitchFrame[] = [];
  for (let i = 0; (i + 1) * hop <= x.length; i++) {
    let a = 0;
    for (let k = 0; k < hop; k++) a += x[i * hop + k] * x[i * hop + k];
    const rms = Math.sqrt(a / hop);
    const fits = i * hop + yin.frameSize <= x.length;
    const clarity = fits && rms > 1e-5 ? yin.analyse(x, i * hop).clarity : 0;
    frames.push({ f0: comb[i]?.f0 ?? 0, clarity, rms });
  }
  return cleanProsody(frames, x.length / fs, { wide: true });
}
