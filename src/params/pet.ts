/**
 * Step 1 of the parameter layer: what the user sculpts (a `PetSpec`: five sliders and a species)
 * → an anatomy (`VoiceBody`) and a way of using it (`VoiceCharacter`).
 *
 * Every number marked EMPIRICAL was tuned by ear/spectrogram against descriptions of the species'
 * calls, not measured from animals. The README lists them.
 */
import type { VoiceBody } from "./protocol.ts";

export type Species = "cat" | "dog";
export type Mood = "coax" | "happy" | "sad" | "angry" | "curious" | "scared" | "sleepy" | "excited";
export const MOODS: Mood[] = ["coax", "happy", "curious", "excited", "sad", "scared", "sleepy", "angry"];

export interface PetSpec {
  species: Species;
  name: string;
  /** body size 0 (smallest of the species) … 1 (largest) */
  size: number;
  /** 0 newborn-ish … 0.5 adult … 1 old */
  age: number;
  /** muzzle 0 flat-faced … 1 long-nosed */
  snout: number;
  mood: Mood;
  /** voice texture −1 clear, bright … 0 … +1 husky, rumbling */
  texture: number;
}

/** How this pet uses its body: the defaults every call starts from. */
export interface VoiceCharacter {
  species: Species;
  mood: Mood;
  /** comfortable pitch of the species' main call (meow / bark), Hz */
  f0: number;
  /** usable pitch range around it */
  f0Min: number;
  f0Max: number;
  /** comfortable lung pressure, cmH₂O */
  pressure: number;
  tension: number;
  breath: number;
  rough: number;
  fry: number;
  /** how wide this pet opens its mouth at full call, 0..1 */
  jawMax: number;
  /** tempo of its gestures: >1 quicker (small, young, excited) */
  speed: number;
  /** vibrato / tremble, cents */
  vibrato: number;
  /** vocal tract length glottis→lips, cm (for display and the README's formant estimate) */
  tractLen: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/**
 * Growth: fraction of adult linear size at `age` (0..1). A young animal's tract is short, and
 * shorter still relative to its folds, which is most of why kittens sound like kittens.
 */
/**
 * A long muzzle is a longer mouth, so a longer tract: 0.88× (flat face) … 1.12× (long nose) of
 * the size slider's length. Without this the muzzle slider only reshuffled a fixed length
 * between throat and mouth, and ablation measured under 2 dB of difference end to end.
 */
export function muzzleScale(snout: number): number {
  return lerp(0.88, 1.12, clamp(snout));
}

export function growth(age: number): number {
  return lerp(0.52, 1, smooth(0, 0.42, age));
}

interface SpeciesAnatomy {
  /** adult vocal tract length (glottis → lips) at size 0 and 1, cm */
  tract: [number, number];
  /** oral share of the tract at snout 0 and 1 */
  oralShare: [number, number];
  /** areas of a reference animal with a `refTract` cm tract, cm² */
  refTract: number;
  pharynxArea: number;
  oralArea: number;
  tracheaArea: number;
  nasalArea: number;
  foldArea: number;
  /** trachea length / tract length */
  tracheaRatio: number;
  /** main-call pitch (Hz) of the reference animal, and how it falls with size: f0 ∝ tract^−k */
  f0Ref: number;
  f0Slope: number;
  gape: number;
  pressure: number;
  /** how pressed the folds are, and how much air leaks, in a plain call (see README: fitted to real recordings) */
  tension: number;
  breath: number;
}

/**
 * EMPIRICAL anatomy. Tract lengths: cats about 6.5–10 cm, dogs 9 cm (toy breeds) to 26 cm
 * (giant breeds). Areas scale with the square of length from one reference animal per species.
 */
const ANATOMY: Record<Species, SpeciesAnatomy> = {
  cat: {
    tract: [6.6, 10.4],
    oralShare: [0.54, 0.68],
    refTract: 8.5,
    pharynxArea: 0.75,
    oralArea: 1.15,
    tracheaArea: 0.36,
    nasalArea: 0.34,
    foldArea: 0.036,
    tracheaRatio: 0.95,
    f0Ref: 560,
    f0Slope: 1.0,
    gape: 1.5,
    pressure: 8,
    tension: 0.42,
    breath: 0.18,
  },
  dog: {
    tract: [9, 26],
    oralShare: [0.52, 0.72],
    refTract: 16,
    pharynxArea: 2.4,
    oralArea: 4.2,
    tracheaArea: 1.5,
    nasalArea: 1.3,
    foldArea: 0.13,
    tracheaRatio: 1.0,
    f0Ref: 380,
    f0Slope: 1.25,
    gape: 1.9,
    pressure: 12,
    tension: 0.7,
    breath: 0.04,
  },
};

/** The anatomy for a spec: tubes and folds, nothing about how they are used. */
export function bodyOf(spec: PetSpec): VoiceBody {
  const an = ANATOMY[spec.species];
  const g = growth(spec.age);
  const adult = lerp(an.tract[0], an.tract[1], clamp(spec.size));
  const tract = adult * g * muzzleScale(spec.snout);
  const k = tract / an.refTract;
  const k2 = k * k;
  const snout = clamp(spec.snout);
  const oralShare = lerp(an.oralShare[0], an.oralShare[1], snout);
  const oralLen = tract * oralShare;
  const pharynxLen = tract - oralLen;
  // old animals: slacker, heavier folds
  const old = smooth(0.6, 1, spec.age);
  // a flat face squeezes the nasal passage (narrower, and not much shorter: the turbinates fold
  // up); a long muzzle carries a long, roomy one
  const nasalLen = oralLen * lerp(1.05, 0.95, snout) + 0.25 * pharynxLen;
  const nasalArea = an.nasalArea * k2 * lerp(0.45, 1.25, snout);
  const foldArea = an.foldArea * k2 * (1 + 0.25 * old);
  return {
    tracheaLen: tract * an.tracheaRatio,
    tracheaArea: an.tracheaArea * k2,
    pharynxLen,
    pharynxArea: an.pharynxArea * k2,
    oralLen,
    // a long muzzle is a narrower one for the same head
    oralArea: an.oralArea * k2 * lerp(1.15, 0.9, snout),
    nasalLen,
    nasalArea,
    foldArea,
    threshold: lerp(1.3, 2.4, clamp((tract - 4) / 22)),
    wallRadiation: 0.5,
    velumArea: nasalArea * 0.8,
    gain: outputGain(spec.species, tract),
    gape: an.gape,
  };
}

/**
 * EMPIRICAL loudness normalisation. Radiated pressure grows with the flow the folds pass, which
 * grows with their area (∝ size²) and the pitch. These power laws were fitted to the unlimited
 * peak of a meow / bark over the size and age grid (scripts/calibrate-gain.ts), so a kitten and a
 * mastiff both peak near 0.5 of full scale. It is a volume knob, not physics.
 */
function outputGain(species: Species, tract: number): number {
  return species === "cat" ? 4.2 * Math.pow(8.5 / tract, 2.2) : 1.15 * Math.pow(16 / tract, 1.3);
}

export function characterOf(spec: PetSpec): VoiceCharacter {
  const an = ANATOMY[spec.species];
  const g = growth(spec.age);
  const adult = lerp(an.tract[0], an.tract[1], clamp(spec.size));
  const tract = adult * g * muzzleScale(spec.snout);
  const old = smooth(0.6, 1, spec.age);
  const young = 1 - smooth(0, 0.42, spec.age);
  // pitch: bigger animals have longer folds; the young have much shorter ones than their tract
  // suggests (EMPIRICAL exponent); the old sag a little
  let f0 = an.f0Ref * Math.pow(an.refTract / adult, an.f0Slope) * Math.pow(1 / g, 1.1) * (1 - 0.16 * old);
  const tex = clamp(spec.texture, -1, 1);
  const husky = Math.max(0, tex);
  const clear = Math.max(0, -tex);
  let pressure = an.pressure * lerp(0.8, 1.1, clamp(spec.size)) * lerp(0.75, 1, g);
  let tension = an.tension + 0.25 * clear - 0.15 * husky;
  let breath = an.breath + 0.22 * husky + 0.08 * young - 0.08 * clear;
  let rough = 0.04 + 0.4 * husky * husky + 0.12 * old;
  let fry = 0.25 * husky * husky + 0.1 * old;
  let jawMax = 0.85;
  let speed = lerp(1.25, 0.8, clamp(spec.size)) * (1 + 0.25 * young) * (1 - 0.15 * old);
  let vibrato = 0;
  // mood: breath, fold tension and noise (EMPIRICAL)
  switch (spec.mood) {
    case "coax": // 撒娇: soft, high, nasal, a little breathy
      f0 *= 1.12;
      pressure *= 0.82;
      tension -= 0.08;
      breath += 0.1;
      jawMax = 0.7;
      break;
    case "happy": // 开心: bright, quick, full
      f0 *= 1.05;
      pressure *= 1.05;
      tension += 0.1;
      speed *= 1.2;
      jawMax = 0.95;
      break;
    case "sad": // 委屈: weak breath, slack, trembling, falling
      f0 *= 0.94;
      pressure *= 0.8;
      tension -= 0.15;
      breath += 0.14;
      jawMax = 0.5;
      speed *= 0.78;
      vibrato = 45;
      break;
    case "angry": // 生气: hard blown, pressed, harsh, low
      f0 *= 0.8;
      pressure *= 1.7;
      tension += 0.22;
      rough += 0.38;
      jawMax = 1;
      break;
    case "curious": // 好奇: small, high, light and clipped: a question mark, not a plea
      f0 *= 1.2;
      pressure *= 0.72;
      tension += 0.12;
      breath -= 0.05;
      speed *= 1.35;
      jawMax = 0.5;
      break;
    case "scared": // 害怕: thin and shaking: weak breath, air leaking, pitch high and unsteady
      f0 *= 1.32;
      pressure *= 0.78;
      tension += 0.05;
      breath += 0.28;
      speed *= 0.95;
      vibrato = 110;
      jawMax = 0.4;
      break;
    case "sleepy": // 困倦: low, slack, creaky, slow, mouth barely open
      f0 *= 0.88;
      pressure *= 0.65;
      tension -= 0.2;
      breath += 0.18;
      fry += 0.2;
      speed *= 0.65;
      jawMax = 0.45;
      break;
    case "excited": // 兴奋: hard blown, bright, fast, mouth wide
      f0 *= 1.15;
      pressure *= 1.3;
      tension += 0.15;
      rough += 0.2;
      speed *= 1.45;
      jawMax = 1;
      break;
  }
  return {
    species: spec.species,
    mood: spec.mood,
    f0,
    f0Min: f0 / 2.4,
    f0Max: f0 * 2.6,
    pressure,
    tension: clamp(tension),
    breath: clamp(breath, 0, 0.7),
    rough: clamp(rough),
    fry: clamp(fry),
    jawMax,
    speed,
    vibrato,
    tractLen: tract,
  };
}

/** Lowest resonance of the open tract as a closed-open tube, Hz (c = 350 m/s). For display. */
export function firstFormant(tractLen: number): number {
  return 35000 / (4 * tractLen);
}

export const DEFAULT_SPEC: PetSpec = { species: "cat", name: "团子", size: 0.45, age: 0.5, snout: 0.45, mood: "coax", texture: -0.1 };
