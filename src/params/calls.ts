/**
 * Step 2 of the parameter layer: named calls → keyframed `VoiceTrack`s.
 *
 * A call is a gesture of the whole mouth plus a breath and pitch shape. A meow really is
 * "m–e–a–o–u": lips part from a hum, the jaw swings open and shut while the tongue slides back.
 * A bark is a hard-blown, harsh burst through a snapped-open jaw. All shapes are EMPIRICAL.
 */
import type { VoiceCharacter } from "./pet.ts";
import type { VoiceFrame, VoiceKey, VoiceTrack } from "./protocol.ts";

export type CatCall = "meow" | "mew" | "trill" | "beckon" | "purr" | "hiss" | "yowl" | "chatter" | "growl" | "caterwaul" | "squeak";
export type DogCall = "bark" | "yap" | "woof" | "growl" | "whine" | "whimper" | "yelp" | "howl" | "bay" | "pant" | "sigh";
export type CallId = CatCall | DogCall;

export const CALLS: Record<"cat" | "dog", CallId[]> = {
  cat: ["meow", "mew", "squeak", "trill", "beckon", "chatter", "purr", "hiss", "growl", "yowl", "caterwaul"],
  dog: ["bark", "yap", "woof", "bay", "howl", "whine", "whimper", "yelp", "growl", "pant", "sigh"],
};

/** The call a pet in each mood reaches for first. */
export const MOOD_CALL: Record<"cat" | "dog", Record<VoiceCharacter["mood"], CallId>> = {
  cat: { coax: "meow", happy: "trill", sad: "mew", angry: "yowl", curious: "mew", scared: "hiss", sleepy: "purr", excited: "chatter" },
  dog: { coax: "whine", happy: "bark", sad: "howl", angry: "growl", curious: "woof", scared: "whimper", sleepy: "sigh", excited: "yap" },
};

export interface CallOptions {
  /** 0..1.5: how hard it is meant (scales breath, opening, pitch excursion). Default 1. */
  intensity?: number;
  /** stretch the call to about this many seconds (repeating units where the call is a series) */
  duration?: number;
  /** multiply the pitch */
  pitch?: number;
}

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

/** The frame a pet rests in: mouth nearly shut, breathing through the nose, no breath pressure. */
export function restFrame(c: VoiceCharacter): VoiceFrame {
  return {
    f0: c.f0,
    pressure: 0,
    jaw: 0.06,
    round: 0,
    tonguePos: 0.5,
    tongueHeight: 0.15,
    tension: c.tension,
    breath: c.breath,
    rough: c.rough,
    fry: c.fry,
    hiss: 0,
    pulseDepth: 0,
    vibrato: c.vibrato,
    larynx: 0,
  };
}

/** Builds a track: each key starts from the previous one and overrides what changes. */
export class TrackBuilder {
  readonly keys: VoiceKey[] = [];
  private cur: VoiceFrame;
  constructor(
    private readonly c: VoiceCharacter,
    start?: Partial<VoiceFrame>,
  ) {
    this.cur = { ...restFrame(c), ...start };
  }
  /** key at absolute time t */
  at(t: number, v: Partial<VoiceFrame> = {}): this {
    this.cur = { ...this.cur, ...v };
    const k: VoiceKey = { t, ...this.cur };
    k.f0 = clamp(k.f0, 15, this.c.f0Max * 1.5);
    const last = this.keys[this.keys.length - 1];
    if (last && t <= last.t) k.t = last.t + 0.001;
    this.keys.push(k);
    return this;
  }
  get time(): number {
    return this.keys.length ? this.keys[this.keys.length - 1].t : 0;
  }
  /** close: breath off, mouth back to rest */
  end(t: number, mic = 1): VoiceTrack {
    this.at(t, { pressure: 0 });
    this.at(t + 0.08, { jaw: 0.06, round: 0, tongueHeight: 0.15, tonguePos: 0.5,  hiss: 0, pulseDepth: 0, larynx: 0 });
    return { keys: this.keys, duration: this.time, mic };
  }
}

/**
 * One meow, written into `b` starting at t0, lasting d seconds, around pitch f.
 * `rise` > 0 ends higher than it starts (asking), < 0 ends lower (complaining).
 */
export function meowUnit(b: TrackBuilder, c: VoiceCharacter, t0: number, d: number, f: number, amp: number, rise: number): void {
  const P = c.pressure * amp;
  const J = c.jawMax * clamp(0.55 + 0.45 * amp);
  const up = Math.pow(2, rise / 12);
  // Shape fitted to the clean real meows (scripts/realcal.ts, scripts/nearest.ts): the voice
  // swells in over about a fifth of a second, the pitch climbs to a peak about a quarter of the
  // way in and then sinks slowly, some three semitones end to end, and the call dies away
  // rather than stopping.
  // m: lips shut, a short hum through the nose
  b.at(t0, { f0: f * 0.9, pressure: P * 0.45, jaw: 0.0, round: 0, tonguePos: 0.8, tongueHeight: 0.55 });
  // e: lips part, tongue high and forward
  b.at(t0 + 0.12 * d, { f0: f * 1.0, pressure: P * 0.85, jaw: 0.35 * J, tonguePos: 0.85, tongueHeight: 0.6 });
  // a: jaw wide, tongue flat; the pitch peaks here
  b.at(t0 + 0.3 * d, { f0: f * 1.09 * Math.sqrt(up), pressure: P, jaw: J, tonguePos: 0.45, tongueHeight: 0.1 });
  // o: jaw closing, lips rounding, tongue pulling back, the pitch sinking
  b.at(t0 + 0.72 * d, { f0: f * 1.0 * up, pressure: P * 0.85, jaw: 0.5 * J, round: 0.55, tonguePos: 0.2, tongueHeight: 0.45 });
  // u: nearly shut, trailing off
  b.at(t0 + d, { f0: f * 0.9 * up, pressure: P * 0.55, jaw: 0.12, round: 0.8, tonguePos: 0.15, tongueHeight: 0.55 });
}

function cat(id: CatCall, c: VoiceCharacter, o: Required<CallOptions>): VoiceTrack {
  const amp = o.intensity;
  const f = c.f0 * o.pitch;
  const b = new TrackBuilder(c);
  const moodRise = { coax: 4, happy: 2, sad: -4, angry: -3, curious: 7, scared: -1, sleepy: -5, excited: 3 }[c.mood];
  switch (id) {
    case "meow": {
      const d = o.duration || 0.66 / c.speed;
      meowUnit(b, c, 0, d, f, amp, moodRise * 0.5);
      return b.end(d + 0.04);
    }
    case "mew": {
      // a small, high, short cry with the mouth barely open: kittens, and adults asking
      const d = o.duration || 0.38 / c.speed;
      const P = c.pressure * 0.75 * amp;
      b.at(0, { f0: f * 1.25, pressure: P * 0.6, jaw: 0.05,  tonguePos: 0.85, tongueHeight: 0.6, tension: clamp(c.tension + 0.1) });
      b.at(0.3 * d, { f0: f * 1.55, pressure: P, jaw: 0.45 * c.jawMax,  tongueHeight: 0.35 });
      b.at(d, { f0: f * (c.mood === "sad" ? 1.05 : 1.3), pressure: P * 0.3, jaw: 0.08, round: 0.3, tongueHeight: 0.5 });
      return b.end(d + 0.03);
    }
    case "trill": {
      // chirrup: mouth shut, a rising hum through the nose, the breath fluttering at ~25 Hz
      const d = o.duration || 0.5 / c.speed;
      const P = c.pressure * 0.8 * amp;
      b.at(0, { f0: f * 0.75, pressure: P * 0.7, jaw: 0.02,  pulseDepth: 0.85, tonguePos: 0.6, tongueHeight: 0.4, breath: clamp(c.breath * 0.6) });
      b.at(0.7 * d, { f0: f * 1.25, pressure: P, jaw: 0.04});
      b.at(d, { f0: f * 1.5, pressure: P * 0.5, jaw: 0.18, pulseDepth: 0.4 });
      return b.end(d + 0.03);
    }
    case "beckon": {
      // "come here": a level, fluttering hum that lifts into an open note and stays up
      // ([gru~aɪ]). Timing and pitch shape are measured from one short teaching clip of a person
      // calling cats this way (docs/reference-recordings.md): about half the call held level,
      // a rise of ~3.7 semitones over the next fifth, then a plateau to the end. Only the shape is
      // taken; the voice is this cat's.
      const d = o.duration || 1.15 / Math.sqrt(c.speed);
      const P = c.pressure * 0.85 * amp;
      const lo = f * 0.9;
      const hi = lo * Math.pow(2, (3.7 * clamp(0.5 + 0.5 * amp, 0.5, 1.25)) / 12);
      // gru: lips nearly shut and rounded, tongue back, the breath fluttering
      b.at(0, { f0: lo, pressure: P * 0.6, jaw: 0.03, round: 0.6, pulseDepth: 0.8, tonguePos: 0.3, tongueHeight: 0.45, breath: clamp(c.breath * 0.7) });
      b.at(0.06, { f0: lo, pressure: P * 0.85, jaw: 0.06 });
      b.at(0.5 * d, { f0: lo * 1.015, pressure: P * 0.9, jaw: 0.1, round: 0.5, pulseDepth: 0.55 });
      // a: the mouth opens as the pitch lifts
      b.at(0.68 * d, { f0: hi, pressure: P, jaw: 0.7 * c.jawMax, round: 0, pulseDepth: 0, tonguePos: 0.5, tongueHeight: 0.15 });
      // ɪ: tongue up and forward, jaw half closing, pitch staying up
      b.at(0.86 * d, { f0: hi * 0.98, pressure: P * 0.9, jaw: 0.35 * c.jawMax, tonguePos: 0.85, tongueHeight: 0.6 });
      b.at(d, { f0: hi, pressure: P * 0.5, jaw: 0.15 });
      return b.end(d + 0.03);
    }
    case "purr": {
      // ~25 Hz glottal pulses on both the out- and the in-breath, mouth shut. Low pressure,
      // slack folds; heard mostly through the body wall.
      const d = o.duration || 3.2;
      const rate = 26 * Math.pow(c.f0 / 560, 0.15);
      const P = Math.max(3.4, c.pressure * 0.5) * amp;
      const breathLen = 0.85 / Math.sqrt(c.speed);
      const base: Partial<VoiceFrame> = { jaw: 0.03,  tension: 0.2, breath: 0.22, rough: 0.12, fry: 0.2, tonguePos: 0.5, tongueHeight: 0.2, vibrato: 0, pulseDepth: 0 };
      let t = 0;
      let out = true;
      b.at(0, { ...base, f0: rate, pressure: 0 });
      while (t < d - 0.2) {
        const len = breathLen * (out ? 1.15 : 0.85);
        // the in-breath purrs a touch higher and quieter
        const r = out ? rate : rate * 1.12;
        const p = out ? P : -P * 0.85;
        b.at(t + 0.08, { f0: r, pressure: p });
        b.at(t + len - 0.08, { f0: r * 0.96, pressure: p });
        b.at(t + len, { pressure: 0 });
        t += len;
        out = !out;
      }
      return b.end(t + 0.02, 3.5);
    }
    case "hiss": {
      // folds apart, no voice: a hard breath through a wide flat mouth, noise at the tongue and teeth
      const d = o.duration || 0.9;
      const P = c.pressure * 2.2 * Math.max(0.7, amp);
      b.at(0, { f0: f, pressure: 0, breath: 1, hiss: 0, jaw: 0.25, tonguePos: 0.8, tongueHeight: 0.8,  rough: 0 });
      b.at(0.06, { pressure: P, hiss: 1, jaw: 0.5 });
      b.at(d * 0.7, { pressure: P * 0.8, hiss: 0.9, tongueHeight: 0.72, jaw: 0.55 });
      b.at(d, { pressure: 0, hiss: 0.2, jaw: 0.3 });
      return b.end(d + 0.02);
    }
    case "yowl": {
      // the long, low, wavering threat: pressed and harsh, mouth held open, pitch sagging then rising
      const d = o.duration || 1.9 / c.speed;
      const P = c.pressure * 1.25 * amp;
      const base = { tension: clamp(c.tension + 0.15), rough: clamp(c.rough + 0.25)};
      b.at(0, { ...base, f0: f * 0.7, pressure: P * 0.5, jaw: 0.1, tonguePos: 0.6, tongueHeight: 0.4 });
      b.at(0.18 * d, { f0: f * 0.95, pressure: P, jaw: 0.55 * c.jawMax, tonguePos: 0.45, tongueHeight: 0.15, vibrato: 30 });
      b.at(0.5 * d, { f0: f * 0.72, pressure: P, jaw: 0.75 * c.jawMax, round: 0.3, tonguePos: 0.3, tongueHeight: 0.3, larynx: 0.5, vibrato: 60 });
      b.at(0.82 * d, { f0: f * 1.05, pressure: P * 1.1, jaw: 0.6 * c.jawMax, round: 0.5, tonguePos: 0.2, tongueHeight: 0.4 });
      b.at(d, { f0: f * 0.62, pressure: P * 0.3, jaw: 0.15, round: 0.75 });
      return b.end(d + 0.04);
    }
    case "chatter": {
      // the jaw clacking at a bird through the window: ~11 quick open-shut bleats a second
      const d = o.duration || 1.1;
      const rate = 11 * Math.sqrt(c.speed);
      const P = c.pressure * 0.7 * amp;
      const n = Math.max(3, Math.round(d * rate));
      b.at(0, { f0: f * 1.5, pressure: 0, jaw: 0.04,  tonguePos: 0.75, tongueHeight: 0.45, tension: clamp(c.tension + 0.2), breath: clamp(c.breath * 0.6) });
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const hi = f * (1.45 + 0.25 * ((i * 5) % 3) * 0.5);
        b.at(t + 0.25 / rate, { f0: hi, pressure: P, jaw: 0.4 * c.jawMax });
        b.at(t + 0.6 / rate, { f0: hi * 0.9, pressure: P * 0.6, jaw: 0.3 * c.jawMax });
        b.at(t + 0.85 / rate, { pressure: 0, jaw: 0.03 });
      }
      return b.end(n / rate + 0.02);
    }
    case "growl": {
      // a cat's growl: low, creaky, harsh, behind nearly shut teeth, swelling toward the end
      const d = o.duration || 1.5;
      const P = c.pressure * 0.8 * amp;
      const lo = Math.max(70, f * 0.33);
      b.at(0, { f0: lo, pressure: P * 0.4, jaw: 0.08,  tonguePos: 0.3, tongueHeight: 0.5, tension: 0.4, rough: clamp(c.rough + 0.4), fry: 0.5, larynx: 0.7 });
      b.at(0.3 * d, { f0: lo * 1.08, pressure: P, jaw: 0.14 });
      b.at(0.8 * d, { f0: lo * 1.3, pressure: P * 1.2, jaw: 0.24, rough: clamp(c.rough + 0.55) });
      b.at(d, { f0: lo * 0.95, pressure: P * 0.3, jaw: 0.08 });
      return b.end(d + 0.04, 1.6);
    }
    case "caterwaul": {
      // the long night-time wail: wide mouth, pitch swinging slowly up and down, never settling
      const d = o.duration || 2.8;
      const P = c.pressure * 1.15 * amp;
      b.at(0, { f0: f * 0.75, pressure: P * 0.5, jaw: 0.1,  tonguePos: 0.7, tongueHeight: 0.45, tension: clamp(c.tension + 0.1), vibrato: 25 });
      const waves = Math.max(2, Math.round(d / 1.1));
      for (let i = 0; i < waves; i++) {
        const t0 = 0.12 * d + (i / waves) * 0.8 * d;
        const w = (0.8 * d) / waves;
        b.at(t0, { f0: f * 0.82, pressure: P * 0.9, jaw: 0.5 * c.jawMax, round: 0.4, tonguePos: 0.3, tongueHeight: 0.35});
        b.at(t0 + 0.5 * w, { f0: f * 1.32, pressure: P, jaw: 0.9 * c.jawMax, round: 0.05, tonguePos: 0.55, tongueHeight: 0.12, vibrato: 45 });
      }
      b.at(0.94 * d, { f0: f * 0.8, pressure: P * 0.7, jaw: 0.4 * c.jawMax, round: 0.6 });
      b.at(d, { f0: f * 0.6, pressure: P * 0.25, jaw: 0.1, round: 0.8 });
      return b.end(d + 0.04);
    }
    case "squeak": {
      // a tiny, very high, very short peep
      const d = o.duration || 0.16;
      const P = c.pressure * 0.8 * amp;
      b.at(0, { f0: f * 1.7, pressure: P * 0.6, jaw: 0.08,  tonguePos: 0.88, tongueHeight: 0.6, tension: clamp(c.tension + 0.25), rough: 0 });
      b.at(0.4 * d, { f0: f * 2.1, pressure: P, jaw: 0.3 * c.jawMax });
      b.at(d, { f0: f * 1.8, pressure: P * 0.3, jaw: 0.06 });
      return b.end(d + 0.02);
    }
  }
}

/**
 * One bark ("wuf"), d seconds at pitch f. The jaw snaps open against a hard breath; the folds
 * are driven into subharmonics and chaos (`rough`), which is what makes a bark a bark.
 */
/**
 * A bark sits well above the pitch a dog growls, whines or howls from. Measured the same way,
 * clean real barks centre on about 560 Hz (quartiles 480–670); ours sat at 350.
 */
const BARK_PITCH = 1.45;

export function barkUnit(b: TrackBuilder, c: VoiceCharacter, t0: number, d: number, f: number, amp: number, rise = 0): void {
  const P = c.pressure * 1.5 * amp;
  const J = c.jawMax * clamp(0.6 + 0.4 * amp);
  const up = Math.pow(2, rise / 12);
  const rough = clamp(c.rough + 0.6 + 0.15 * amp);
  // Shape fitted to real barks (scripts/realcal.ts): the pitch hardly moves (a semitone or two),
  // and the voice is dark: most of the energy sits between 400 Hz and 1.7 kHz.
  // w: lips together and rounded, pressure already up behind them
  b.at(t0, { f0: f * 0.93, pressure: P * 0.5, jaw: 0.03, round: 0.7, tonguePos: 0.25, tongueHeight: 0.45, rough, larynx: 0.2 });
  // u→a: the jaw snaps open
  b.at(t0 + 0.26 * d, { f0: f * 1.05 * Math.sqrt(up), pressure: P, jaw: J, round: 0.15, tonguePos: 0.4, tongueHeight: 0.12 });
  b.at(t0 + 0.6 * d, { f0: f * 1.0 * up, pressure: P * 0.9, jaw: J * 0.8, round: 0.25 });
  // f: shut on a puff of breath
  b.at(t0 + d, { f0: f * 0.9 * up, pressure: P * 0.25, jaw: 0.08, round: 0.5, breath: clamp(c.breath + 0.35) });
  b.at(t0 + d + 0.03, { pressure: 0, breath: c.breath, rough: c.rough, larynx: 0 });
}

function dog(id: DogCall, c: VoiceCharacter, o: Required<CallOptions>): VoiceTrack {
  const amp = o.intensity;
  const f = c.f0 * o.pitch;
  const b = new TrackBuilder(c);
  switch (id) {
    case "bark": {
      const unit = 0.19 / Math.sqrt(c.speed);
      const gap = 0.16 / c.speed;
      const n = o.duration ? Math.max(1, Math.round(o.duration / (unit + gap))) : c.mood === "happy" ? 3 : 2;
      let t = 0;
      for (let i = 0; i < n; i++) {
        barkUnit(b, c, t, unit, f * BARK_PITCH * (1 + 0.04 * ((i * 7) % 3) - 0.04), amp * (i === 0 ? 1 : 0.92));
        t += unit + gap;
      }
      return b.end(t - gap + 0.05);
    }
    case "yap": {
      // the small-dog bark: higher, shorter, cleaner, in a quick run
      const unit = 0.11 / Math.sqrt(c.speed);
      const gap = 0.1 / c.speed;
      const n = o.duration ? Math.max(1, Math.round(o.duration / (unit + gap))) : 3;
      let t = 0;
      for (let i = 0; i < n; i++) {
        barkUnit(b, c, t, unit, f * 1.35, amp * 0.9, 2);
        t += unit + gap;
      }
      return b.end(t - gap + 0.05);
    }
    case "growl": {
      // low and slack-pulsed (fry + chaos), mouth nearly shut, lips drawn back, larynx pulled down
      // so the tract sounds as long as it can
      const d = o.duration || 1.6;
      const P = c.pressure * 0.75 * amp;
      const lo = Math.max(55, f * 0.3);
      b.at(0, { f0: lo, pressure: P * 0.4, jaw: 0.1, round: 0,  tonguePos: 0.25, tongueHeight: 0.55, tension: 0.35, rough: clamp(c.rough + 0.35), fry: 0.55, larynx: 0.9, hiss: 0.15, breath: clamp(c.breath + 0.1) });
      b.at(0.25 * d, { f0: lo * 1.12, pressure: P, jaw: 0.16 });
      b.at(0.6 * d, { f0: lo * 0.95, pressure: P * 0.9, jaw: 0.2, pulseDepth: 0.3});
      b.at(0.9 * d, { f0: lo * 1.2, pressure: P * 1.15, jaw: 0.28, rough: clamp(c.rough + 0.5) });
      b.at(d, { f0: lo * 0.9, pressure: P * 0.3, jaw: 0.1 });
      return b.end(d + 0.04, 1.6);
    }
    case "whine": {
      // high, thin, nearly pure, through the nose with the mouth shut; pitch arches and wobbles
      const d = o.duration || 0.9 / c.speed;
      const P = c.pressure * 0.6 * amp;
      const hi = Math.min(c.f0Max * 1.4, f * 2.6);
      b.at(0, { f0: hi * 0.8, pressure: P * 0.5, jaw: 0.02,  tonguePos: 0.85, tongueHeight: 0.65, tension: clamp(c.tension + 0.25), rough: 0, fry: 0, breath: clamp(c.breath + 0.1), vibrato: 25 });
      b.at(0.3 * d, { f0: hi * 1.05, pressure: P, jaw: 0.06 });
      b.at(0.65 * d, { f0: hi * 0.95, pressure: P * 0.9, vibrato: 50 });
      b.at(d, { f0: hi * (c.mood === "coax" ? 1.12 : 0.7), pressure: P * 0.3 });
      return b.end(d + 0.04);
    }
    case "howl": {
      // long and tonal: swoop up, hold with rounded protruded lips, sag at the end
      const d = o.duration || 2.4;
      const P = c.pressure * 0.95 * amp;
      const f1 = f * 1.5;
      b.at(0, { f0: f * 0.75, pressure: P * 0.5, jaw: 0.12, round: 0.6,  tonguePos: 0.25, tongueHeight: 0.4, rough: clamp(c.rough * 0.4), fry: 0, tension: clamp(c.tension + 0.05) });
      b.at(0.16 * d, { f0: f1, pressure: P, jaw: 0.5 * c.jawMax, round: 0.85, larynx: 0.4, vibrato: 12 });
      b.at(0.65 * d, { f0: f1 * 1.03, pressure: P, jaw: 0.55 * c.jawMax, vibrato: 25 });
      b.at(0.9 * d, { f0: f1 * 0.8, pressure: P * 0.7, jaw: 0.35 * c.jawMax });
      b.at(d, { f0: f1 * 0.62, pressure: P * 0.25, jaw: 0.12, round: 0.9 });
      return b.end(d + 0.05);
    }
    case "pant": {
      // voiceless: breath in and out through a wide-open mouth, a few times a second
      const d = o.duration || 1.6;
      const P = c.pressure * 1.4 * amp;
      const rate = 4.2 * c.speed;
      b.at(0, { pressure: 0, breath: 1, jaw: 0.8, tonguePos: 0.55, tongueHeight: 0.55,  hiss: 0.5, rough: 0, round: 0 });
      const n = Math.max(2, Math.round(d * rate));
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        const sign = i % 2 === 0 ? 1 : -0.8;
        b.at(t + 0.2 / rate, { pressure: P * sign, hiss: 0.9 });
        b.at(t + 0.75 / rate, { pressure: P * sign * 0.8 });
        b.at(t + 1 / rate, { pressure: 0 });
      }
      return b.end(n / rate + 0.02);
    }
    case "woof": {
      // one low, soft, closed-mouth bark ("boof"): cheeks puff, lips barely part
      const d = o.duration || 0.3 / Math.sqrt(c.speed);
      const P = c.pressure * 1.1 * amp;
      b.at(0, { f0: f * 0.62, pressure: P * 0.7, jaw: 0.02, round: 0.85,  tonguePos: 0.2, tongueHeight: 0.5, rough: clamp(c.rough + 0.15), larynx: 0.5, breath: clamp(c.breath + 0.1) });
      b.at(0.25 * d, { f0: f * 0.8, pressure: P, jaw: 0.3 * c.jawMax, round: 0.6 });
      b.at(0.7 * d, { f0: f * 0.66, pressure: P * 0.7, jaw: 0.2 * c.jawMax, round: 0.7 });
      b.at(d, { f0: f * 0.5, pressure: P * 0.2, jaw: 0.04, round: 0.85, breath: clamp(c.breath + 0.4) });
      return b.end(d + 0.05);
    }
    case "whimper": {
      // a run of short, high, falling notes through the nose, breathy and unsteady
      const unit = 0.2 / Math.sqrt(c.speed);
      const gap = 0.11;
      const n = o.duration ? Math.max(2, Math.round(o.duration / (unit + gap))) : 4;
      const P = c.pressure * 0.55 * amp;
      const hi = Math.min(c.f0Max * 1.3, f * 2.3);
      b.at(0, { f0: hi, pressure: 0, jaw: 0.02,  tonguePos: 0.85, tongueHeight: 0.65, tension: clamp(c.tension + 0.15), breath: clamp(c.breath + 0.2), rough: 0, vibrato: 60 });
      let t = 0;
      for (let i = 0; i < n; i++) {
        const top = hi * (1 - 0.06 * i);
        b.at(t + 0.02, { f0: top, pressure: P });
        b.at(t + unit * 0.6, { f0: top * 0.82, pressure: P * 0.8, jaw: 0.05 });
        b.at(t + unit, { f0: top * 0.68, pressure: 0 });
        t += unit + gap;
      }
      return b.end(t - gap + 0.04);
    }
    case "yelp": {
      // one sharp cry: pitch shoots up and breaks off, mouth flung open
      const d = o.duration || 0.22;
      const P = c.pressure * 1.7 * amp;
      const hi = Math.min(c.f0Max * 1.4, f * 2.5);
      b.at(0, { f0: hi * 0.6, pressure: P * 0.8, jaw: 0.1,  tonguePos: 0.7, tongueHeight: 0.4, tension: clamp(c.tension + 0.3), rough: clamp(c.rough + 0.1) });
      b.at(0.25 * d, { f0: hi, pressure: P, jaw: c.jawMax, tongueHeight: 0.15 });
      b.at(0.75 * d, { f0: hi * 0.85, pressure: P * 0.8, jaw: 0.7 * c.jawMax });
      b.at(d, { f0: hi * 0.5, pressure: P * 0.2, jaw: 0.15 });
      return b.end(d + 0.04);
    }
    case "bay": {
      // a hound's bay: each one starts as a bark and opens into a long held note
      const unit = 0.85 / Math.sqrt(c.speed);
      const gap = 0.25;
      const n = o.duration ? Math.max(1, Math.round(o.duration / (unit + gap))) : 2;
      const P = c.pressure * 1.25 * amp;
      let t = 0;
      for (let i = 0; i < n; i++) {
        b.at(t, { f0: f * 0.8, pressure: P * 0.7, jaw: 0.03, round: 0.7,  tonguePos: 0.25, tongueHeight: 0.45, rough: clamp(c.rough + 0.35), tension: clamp(c.tension + 0.1), larynx: 0.2 });
        b.at(t + 0.07, { f0: f * 1.25, pressure: P, jaw: c.jawMax, round: 0.1, tongueHeight: 0.12 });
        b.at(t + 0.22, { f0: f * 1.4, pressure: P * 0.9, jaw: 0.7 * c.jawMax, round: 0.55, rough: clamp(c.rough + 0.1), vibrato: 20 });
        b.at(t + 0.75 * unit, { f0: f * 1.3, pressure: P * 0.85, jaw: 0.55 * c.jawMax, round: 0.75 });
        b.at(t + unit, { f0: f * 0.95, pressure: P * 0.2, jaw: 0.1, round: 0.85 });
        b.at(t + unit + 0.03, { pressure: 0 });
        t += unit + gap;
      }
      return b.end(t - gap + 0.05);
    }
    case "sigh": {
      // voiceless: one long breath out through the nose and barely parted lips, fading
      const d = o.duration || 1.1;
      const P = c.pressure * 0.9 * amp;
      b.at(0, { pressure: 0, breath: 1, jaw: 0.12,  tonguePos: 0.5, tongueHeight: 0.45, hiss: 0.5, rough: 0, round: 0.2 });
      b.at(0.12 * d, { pressure: P * 1.6, hiss: 1 });
      b.at(0.6 * d, { pressure: P * 0.8, jaw: 0.08 });
      b.at(d, { pressure: 0, hiss: 0.2 });
      return b.end(d + 0.02, 2.5);
    }
  }
}

export function makeCall(c: VoiceCharacter, id: CallId, opts: CallOptions = {}): VoiceTrack {
  const o: Required<CallOptions> = { intensity: clamp(opts.intensity ?? 1, 0.2, 1.5), duration: opts.duration ?? 0, pitch: opts.pitch ?? 1 };
  if (c.species === "cat") return cat((CALLS.cat.includes(id) ? id : "meow") as CatCall, c, o);
  return dog((CALLS.dog.includes(id) ? id : "bark") as DogCall, c, o);
}
