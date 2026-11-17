/**
 * What a recording of a pet's call says about its voice: pitch, how clean the voice is, and an
 * estimate of the vocal tract's length from where the resonances sit.
 *
 * Tract length: an open tube closed at the glottis resonates at (2k−1)·c/4L, with dips halfway
 * between (k·c/2L). The long-term spectrum's envelope is compared with that comb for every L from
 * 3 to 32 cm; the best match is the estimate. It works when the call's harmonics (or noise) fill
 * the envelope in: barks, growls, hisses, purrs, and calls whose pitch glides. A steady high meow
 * has too few harmonics per resonance, and the estimate is then reported with low confidence.
 */
import { combPitch } from "./comb.ts";
import { fft } from "./fft.ts";
import { resample } from "./prosody.ts";
import { Yin } from "./yin.ts";

export const PET_RATE = 24000;

export interface PetSoundMeasure {
  duration: number;
  /** seconds of the recording that carry sound */
  activeSeconds: number;
  /** tonal: has a pitch. purr: a slow pulse train. noisy: breath or hiss only */
  kind: "tonal" | "purr" | "noisy";
  /** median pitch of the voiced part, Hz (0 when there is none) */
  f0: number;
  f0Low: number;
  f0High: number;
  /** pulse rate, Hz, when kind is "purr" */
  pulseRate: number;
  /** 0 noise … 1 perfectly periodic, median over the voiced part */
  clarity: number;
  voicedFraction: number;
  /** estimated vocal tract length, cm (0: could not tell) */
  tractLen: number;
  /** 0..1: margin of the best length over its nearest rival */
  tractConfidence: number;
  tractCandidates: { tractLen: number; weight: number }[];
  /** harmonics-to-noise ratio of the voiced part, dB (0 when unvoiced) */
  hnr: number;
  /** median frame-to-frame pitch wobble, cents */
  jitter: number;
  /** share of the energy above 4 kHz, 0..1 */
  bright: number;
}

const C = 35000;

function quantile(v: number[], q: number): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/** Long-term average spectrum (power per bin) of the loud frames. */
function ltas(x: Float32Array, loud: (frame: number) => boolean, n: number, hop: number): Float64Array {
  const acc = new Float64Array(n / 2);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let count = 0;
  for (let s = 0, f = 0; s + n <= x.length; s += hop, f++) {
    if (!loud(f)) continue;
    for (let i = 0; i < n; i++) {
      re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
      im[i] = 0;
    }
    fft(re, im);
    for (let i = 0; i < n / 2; i++) acc[i] += re[i] * re[i] + im[i] * im[i];
    count++;
  }
  if (count) for (let i = 0; i < acc.length; i++) acc[i] /= count;
  return acc;
}

/**
 * Tract length from a spectrum: envelope (peaks joined across harmonics), tilt removed, then the
 * resonance comb. `f0` widens the envelope smoothing to bridge the gaps between harmonics.
 */
export interface TractEstimate {
  tractLen: number;
  confidence: number;
  /** alternative lengths, best first, weight 1 for the best */
  candidates: { tractLen: number; weight: number }[];
}

export function tractFromSpectrum(power: Float64Array, fs: number, f0: number): TractEstimate {
  const bins = power.length;
  const binHz = fs / 2 / bins;
  const db = new Float64Array(bins);
  for (let i = 0; i < bins; i++) db[i] = 10 * Math.log10(power[i] + 1e-12);
  // envelope: running maximum over ±0.6 f0, then a mean of the same width
  const half = Math.max(2, Math.round((Math.max(60, Math.min(f0 || 150, 900)) * 0.6) / binHz));
  const ridge = new Float64Array(bins);
  for (let i = 0; i < bins; i++) {
    let m = -Infinity;
    for (let k = Math.max(0, i - half); k <= Math.min(bins - 1, i + half); k++) if (db[k] > m) m = db[k];
    ridge[i] = m;
  }
  const env = new Float64Array(bins);
  const smooth = (src: Float64Array, dst: Float64Array, w: number) => {
    let run = 0;
    const pre = new Float64Array(bins + 1);
    for (let i = 0; i < bins; i++) pre[i + 1] = (run += src[i]);
    for (let i = 0; i < bins; i++) {
      const a = Math.max(0, i - w);
      const b = Math.min(bins, i + w + 1);
      dst[i] = (pre[b] - pre[a]) / (b - a);
    }
  };
  smooth(ridge, env, half);
  // tilt: the same envelope smoothed over ±2.5 kHz
  const tilt = new Float64Array(bins);
  smooth(env, tilt, Math.round(2500 / binHz));
  const lo = 250;
  const hi = Math.min(fs / 2 - 500, 11000);
  const at = (hz: number) => {
    const i = Math.min(bins - 1, Math.max(0, Math.round(hz / binHz)));
    return env[i] - tilt[i];
  };
  const scores: number[] = [];
  const lens: number[] = [];
  for (let L = 3; L <= 32; L *= 1.02) {
    let s = 0;
    let n = 0;
    for (let k = 1; k <= 8; k++) {
      const peak = ((2 * k - 1) * C) / (4 * L);
      const dip = (k * C) / (2 * L);
      if (peak < lo || dip > hi) continue;
      s += at(peak) - at(dip);
      n++;
    }
    // At least two resonances inside the band, or the fit says nothing. Sum over √n: a tube a
    // third as long matches every third resonance just as well per term (so a plain mean would
    // tie), and one three times as long dilutes the same matches over three times the terms.
    scores.push(n >= 2 ? s / Math.sqrt(n) : -Infinity);
    lens.push(L);
  }
  // local maxima of the fit, best first: the top one is the estimate, the rest are the
  // alternatives a caller may prefer when other evidence (the pitch) contradicts it
  const peaks: { tractLen: number; score: number }[] = [];
  for (let i = 0; i < scores.length; i++) {
    if (!Number.isFinite(scores[i]) || scores[i] <= 0) continue;
    const l = i > 0 ? scores[i - 1] : -Infinity;
    const r = i + 1 < scores.length ? scores[i + 1] : -Infinity;
    if (scores[i] >= l && scores[i] >= r) peaks.push({ tractLen: lens[i], score: scores[i] });
  }
  peaks.sort((a, b) => b.score - a.score);
  if (!peaks.length) return { tractLen: 0, confidence: 0, candidates: [] };
  const top = peaks[0];
  // a rival is a peak at a clearly different length; confidence is the margin over it
  const rival = peaks.find((p) => Math.abs(Math.log(p.tractLen / top.tractLen)) > 0.25);
  const confidence = Math.max(0, Math.min(1, rival ? (top.score - rival.score) / top.score / 0.5 : 1));
  return { tractLen: top.tractLen, confidence, candidates: peaks.slice(0, 4).map((p) => ({ tractLen: p.tractLen, weight: p.score / top.score })) };
}

export function measurePetSound(input: Float32Array, sampleRate: number): PetSoundMeasure {
  const x = resample(input, sampleRate, PET_RATE);
  const fs = PET_RATE;
  const hop = 240;
  const duration = x.length / fs;
  const empty: PetSoundMeasure = { duration, activeSeconds: 0, kind: "noisy", f0: 0, f0Low: 0, f0High: 0, pulseRate: 0, clarity: 0, voicedFraction: 0, tractLen: 0, tractConfidence: 0, tractCandidates: [], hnr: 0, jitter: 0, bright: 0 };
  if (x.length < fs * 0.12) return empty;

  // loudness per 10 ms
  const nF = Math.floor(x.length / hop);
  const rms = new Float32Array(nF);
  for (let f = 0; f < nF; f++) {
    let a = 0;
    for (let i = 0; i < hop; i++) a += x[f * hop + i] * x[f * hop + i];
    rms[f] = Math.sqrt(a / hop);
  }
  const loudLevel = quantile(Array.from(rms), 0.95);
  if (loudLevel < 1e-4) return empty;
  const active = (f: number) => f < nF && rms[f] > loudLevel * 0.12;
  let activeN = 0;
  for (let f = 0; f < nF; f++) if (active(f)) activeN++;

  // periodicity (YIN's clarity) and pitch (harmonic comb, which survives a weak fundamental)
  const yin = new Yin({ sampleRate: fs, fMin: 55, fMax: 2600, threshold: 0.15 });
  const comb = combPitch(x, fs, 55, 2600, hop / fs);
  const f0s: number[] = [];
  const clar: number[] = [];
  const wobble: number[] = [];
  const voicedFrames: { f: number; f0: number }[] = [];
  let lastYin = 0;
  let voicedN = 0;
  for (let f = 0; f < nF; f++) {
    if (!active(f) || f * hop + yin.frameSize > x.length) continue;
    const y = yin.analyse(x, f * hop);
    if (y.clarity > 0.55) {
      voicedN++;
      clar.push(y.clarity);
      const c = comb[f];
      if (c && c.f0 > 0) {
        f0s.push(c.f0);
        voicedFrames.push({ f, f0: c.f0 });
      }
      if (lastYin > 0) {
        const cents = Math.abs(1200 * Math.log2(y.f0 / lastYin));
        if (cents < 600) wobble.push(cents);
      }
      lastYin = y.f0;
    } else lastYin = 0;
  }
  const voicedFraction = activeN ? voicedN / activeN : 0;

  // purr: the loudness itself pulses at 18–40 Hz
  let pulseRate = 0;
  let pulseStrength = 0;
  {
    // envelope at 1 kHz
    const env: number[] = [];
    for (let i = 0; i + fs / 1000 <= x.length; i += fs / 1000) {
      let a = 0;
      for (let j = 0; j < fs / 1000; j++) a += Math.abs(x[i + j]);
      env.push(a);
    }
    const m = env.reduce((a, b) => a + b, 0) / Math.max(1, env.length);
    let e0 = 0;
    for (const v of env) e0 += (v - m) * (v - m);
    // lags 20..62 ms; only a peak strictly inside 25..56 ms (18–40 Hz) counts, so a slope that
    // merely runs off the edge of the range is not taken for a pulse
    const ac: number[] = [];
    for (let lag = 20; lag <= 62 && lag < env.length / 3; lag++) {
      let s = 0;
      for (let i = 0; i + lag < env.length; i++) s += (env[i] - m) * (env[i + lag] - m);
      ac.push(s / (e0 || 1));
    }
    for (let i = 5; i + 6 < ac.length; i++) {
      if (ac[i] > pulseStrength && ac[i] > ac[i - 3] && ac[i] > ac[i + 3]) {
        pulseStrength = ac[i];
        pulseRate = 1000 / (20 + i);
      }
    }
  }

  const f0 = quantile(f0s, 0.5);
  const isPurr = pulseStrength > 0.45 && (voicedFraction < 0.5 || f0 < 120);
  const kind: PetSoundMeasure["kind"] = isPurr ? "purr" : voicedFraction > 0.3 && f0 > 0 ? "tonal" : "noisy";

  // harmonics-to-noise: power within ±12% of each harmonic against the power between them
  let hnr = 0;
  if (kind === "tonal" && voicedFrames.length) {
    const n = 2048;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const ratios: number[] = [];
    for (const v of voicedFrames) {
      const s0 = v.f * hop;
      if (s0 + n > x.length) continue;
      for (let i = 0; i < n; i++) {
        re[i] = x[s0 + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
        im[i] = 0;
      }
      fft(re, im);
      let harm = 0;
      let noise = 0;
      const top = Math.min(n / 2, Math.floor(8000 / (fs / n)));
      for (let i = 2; i < top; i++) {
        const hz = (i * fs) / n;
        const k = hz / v.f0;
        const off = Math.abs(k - Math.round(k));
        const p = re[i] * re[i] + im[i] * im[i];
        if (k < 0.7) continue;
        if (off < 0.12) harm += p;
        else if (off > 0.3) noise += p;
      }
      if (noise > 0) ratios.push(10 * Math.log10((harm + 1e-12) / noise));
    }
    hnr = quantile(ratios, 0.5);
  }

  const spectrum = ltas(x, (f) => active(f), 1024, hop);
  let lowE = 0;
  let highE = 0;
  for (let i = 0; i < spectrum.length; i++) {
    if ((i * fs) / 1024 >= 4000) highE += spectrum[i];
    else lowE += spectrum[i];
  }
  const bright = highE / Math.max(1e-12, lowE + highE);
  const tract = tractFromSpectrum(spectrum, fs, kind === "tonal" ? f0 : 0);

  return {
    duration,
    activeSeconds: (activeN * hop) / fs,
    kind,
    f0: kind === "tonal" ? f0 : 0,
    f0Low: kind === "tonal" ? quantile(f0s, 0.1) : 0,
    f0High: kind === "tonal" ? quantile(f0s, 0.9) : 0,
    pulseRate: isPurr ? pulseRate : 0,
    clarity: quantile(clar, 0.5),
    voicedFraction,
    tractLen: tract.tractLen,
    tractConfidence: tract.confidence,
    tractCandidates: tract.candidates,
    hnr,
    jitter: quantile(wobble, 0.5),
    bright,
  };
}
