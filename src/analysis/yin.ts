/**
 * YIN pitch estimation (de Cheveigné & Kawahara 2002): difference function, cumulative mean
 * normalised difference, absolute threshold, parabolic interpolation. Runs per frame, so the same
 * code tracks a live microphone and a decoded file.
 */

export interface YinOptions {
  sampleRate: number;
  fMin: number;
  fMax: number;
  /** CMND threshold for the first dip (0.1–0.2 typical) */
  threshold?: number;
  /** integration window, samples (default: 2.2 periods of fMin... capped by the frame) */
  window?: number;
}

export interface PitchFrame {
  /** Hz, or 0 when unvoiced */
  f0: number;
  /** 1 − CMND at the chosen lag: 0 noise … 1 perfectly periodic */
  clarity: number;
  /** RMS of the frame */
  rms: number;
}

export class Yin {
  readonly tauMin: number;
  readonly tauMax: number;
  readonly window: number;
  /** samples a frame must hold */
  readonly frameSize: number;
  private readonly d: Float32Array;
  private readonly threshold: number;
  private readonly fs: number;

  constructor(o: YinOptions) {
    this.fs = o.sampleRate;
    this.tauMin = Math.max(2, Math.floor(o.sampleRate / o.fMax));
    this.tauMax = Math.ceil(o.sampleRate / o.fMin);
    this.window = o.window ?? Math.ceil(this.tauMax * 1.5);
    this.frameSize = this.window + this.tauMax + 1;
    this.d = new Float32Array(this.tauMax + 2);
    this.threshold = o.threshold ?? 0.15;
  }

  /** Analyse `x[start .. start + frameSize)`. */
  analyse(x: Float32Array, start = 0): PitchFrame {
    const W = this.window;
    const d = this.d;
    let energy = 0;
    for (let j = 0; j < W; j++) energy += x[start + j] * x[start + j];
    const rms = Math.sqrt(energy / W);
    if (rms < 1e-5) return { f0: 0, clarity: 0, rms };
    // difference function and its cumulative mean normalisation
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= this.tauMax + 1; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const diff = x[start + j] - x[start + j + tau];
        s += diff * diff;
      }
      running += s;
      d[tau] = running > 0 ? (s * tau) / running : 1;
    }
    // first dip under the threshold, followed down to its local minimum
    let tau = -1;
    for (let t = this.tauMin; t <= this.tauMax; t++) {
      if (d[t] < this.threshold) {
        while (t + 1 <= this.tauMax && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      // no clear dip: report the global minimum with its (poor) clarity, the caller decides
      let best = this.tauMin;
      for (let t = this.tauMin; t <= this.tauMax; t++) if (d[t] < d[best]) best = t;
      tau = best;
    }
    // parabolic interpolation around the minimum
    let better = tau;
    if (tau > 1 && tau < this.tauMax) {
      const a = d[tau - 1];
      const b = d[tau];
      const c = d[tau + 1];
      const den = a - 2 * b + c;
      if (Math.abs(den) > 1e-12) better = tau + (0.5 * (a - c)) / den;
    }
    return { f0: this.fs / better, clarity: 1 - d[tau], rms };
  }
}

/** Track a whole signal: one PitchFrame every `hop` samples. */
export function trackPitch(x: Float32Array, o: YinOptions, hop: number): PitchFrame[] {
  const yin = new Yin(o);
  const out: PitchFrame[] = [];
  for (let s = 0; s + yin.frameSize <= x.length; s += hop) out.push(yin.analyse(x, s));
  return out;
}
