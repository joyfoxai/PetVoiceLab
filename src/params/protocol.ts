/**
 * The boundary between the parameter layer and the sounding layer.
 *
 * The parameter layer (this folder) decides WHAT the pet does: an anatomy (`VoiceBody`) and a
 * time series of vocal states (`VoiceFrame`s in a `VoiceTrack`). The sounding layer (the Rust
 * engine in an AudioWorklet) only turns those numbers into air. Nothing else crosses.
 *
 * Field order here mirrors engine/src/pet.rs (B_* and F_* constants). Change both together.
 */

/** Static anatomy. Lengths in cm, areas in cm². */
export interface VoiceBody {
  tracheaLen: number;
  tracheaArea: number;
  pharynxLen: number;
  pharynxArea: number;
  oralLen: number;
  oralArea: number;
  nasalLen: number;
  nasalArea: number;
  /** peak vibratory glottal area at full effort */
  foldArea: number;
  /** phonation threshold pressure, cmH₂O */
  threshold: number;
  /** fraction of wall motion radiated through the skin, 0..1 */
  wallRadiation: number;
  /** widest velum port */
  velumArea: number;
  /** output normalisation */
  gain: number;
  /** widest lip opening relative to the oral tube's area */
  gape: number;
}

export const BODY_KEYS = [
  "tracheaLen",
  "tracheaArea",
  "pharynxLen",
  "pharynxArea",
  "oralLen",
  "oralArea",
  "nasalLen",
  "nasalArea",
  "foldArea",
  "threshold",
  "wallRadiation",
  "velumArea",
  "gain",
  "gape",
] as const satisfies readonly (keyof VoiceBody)[];

/** What the voice is doing at one instant. */
export interface VoiceFrame {
  /** fundamental frequency, Hz */
  f0: number;
  /** lung pressure, cmH₂O (negative: breathing in) */
  pressure: number;
  /** mouth opening 0..1 (0 seals the lips) */
  jaw: number;
  /** lip rounding / protrusion 0..1 */
  round: number;
  /** where the tongue narrows the tract: 0 throat … 1 behind the teeth */
  tonguePos: number;
  /** how much: 0 flat … 1 nearly closed */
  tongueHeight: number;
  /** fold tension 0..1: slack → pressed, bright */
  tension: number;
  /** breathiness 0..1 (above ~0.85 the folds stop: hiss, pant) */
  breath: number;
  /** harshness 0..1: subharmonics → chaos */
  rough: number;
  /** creak 0..1 */
  fry: number;
  /** mouth turbulence 0..1 */
  hiss: number;
  /** depth 0..1 of a ~25 Hz pulse on the breath: trills */
  pulseDepth: number;
  /** vibrato depth, cents */
  vibrato: number;
  /** larynx lowering 0..1 (longer throat) */
  larynx: number;
}

export const FRAME_KEYS = [
  "f0",
  "pressure",
  "jaw",
  "round",
  "tonguePos",
  "tongueHeight",
  "tension",
  "breath",
  "rough",
  "fry",
  "hiss",
  "pulseDepth",
  "vibrato",
  "larynx",
] as const satisfies readonly (keyof VoiceFrame)[];

export const N_BODY = BODY_KEYS.length;
export const N_FRAME = FRAME_KEYS.length;
export const KEY_SIZE = 1 + N_FRAME;

/** A keyframe: the state the voice should be in at time t (seconds from the track's start). */
export interface VoiceKey extends VoiceFrame {
  t: number;
}

/** A call: keyframes in time order. The engine interpolates (pitch in log frequency). */
export interface VoiceTrack {
  keys: VoiceKey[];
  /** seconds; the last key's time */
  duration: number;
  /**
   * Playback gain, as if the microphone moved closer (default 1). Not part of the physics: a
   * purr is some 40 dB quieter than a meow at the same distance, and nobody listens to both
   * from the same distance.
   */
  mic?: number;
}

export function packBody(b: VoiceBody, out: Float64Array = new Float64Array(N_BODY)): Float64Array {
  for (let i = 0; i < N_BODY; i++) out[i] = b[BODY_KEYS[i]];
  return out;
}

export function packFrame(f: VoiceFrame, out: Float64Array = new Float64Array(N_FRAME), at = 0): Float64Array {
  for (let i = 0; i < N_FRAME; i++) out[at + i] = f[FRAME_KEYS[i]];
  return out;
}

export function packTrack(t: VoiceTrack): Float64Array {
  const out = new Float64Array(t.keys.length * KEY_SIZE);
  t.keys.forEach((k, i) => {
    out[i * KEY_SIZE] = k.t;
    packFrame(k, out, i * KEY_SIZE + 1);
  });
  return out;
}

/** Telemetry block layout (engine/src/pet.rs T_*). */
export const T = {
  clock: 0,
  trackTime: 1,
  outRms: 2,
  glottis: 3,
  voicing: 4,
  f0: 5,
  velum: 6,
  nPh: 7,
  nOr: 8,
  nNa: 9,
  lenPh: 10,
  lenOr: 11,
  lenNa: 12,
  gate: 13,
  foldPhase: 14,
  flow: 15,
  frame: 16,
  header: 16 + N_FRAME,
} as const;

/** One telemetry snapshot, decoded. Everything a renderer may draw comes from here. */
export interface Telemetry {
  clock: number;
  /** seconds into the playing track, or −1 */
  trackTime: number;
  outRms: number;
  /** mean glottal area since the last snapshot, cm² */
  glottis: number;
  voicing: number;
  f0: number;
  velumArea: number;
  gate: number;
  flow: number;
  lenPh: number;
  lenOr: number;
  lenNa: number;
  /** the smoothed frame the engine is actually using */
  frame: VoiceFrame;
  /** area functions, cm², glottis → lips / velum → nostrils */
  pharynx: Float32Array;
  oral: Float32Array;
  nasal: Float32Array;
  /** acoustic pressure RMS per section, dyn/cm² */
  pharynxRms: Float32Array;
  oralRms: Float32Array;
  nasalRms: Float32Array;
}

export function decodeTelemetry(b: Float32Array): Telemetry {
  const nPh = b[T.nPh];
  const nOr = b[T.nOr];
  const nNa = b[T.nNa];
  const frame = {} as VoiceFrame;
  for (let i = 0; i < N_FRAME; i++) frame[FRAME_KEYS[i]] = b[T.frame + i];
  let o = T.header;
  const take = (n: number) => {
    const s = b.subarray(o, o + n);
    o += n;
    return s;
  };
  const pharynx = take(nPh);
  const oral = take(nOr);
  const nasal = take(nNa);
  return {
    clock: b[T.clock],
    trackTime: b[T.trackTime],
    outRms: b[T.outRms],
    glottis: b[T.glottis],
    voicing: b[T.voicing],
    f0: b[T.f0],
    velumArea: b[T.velum],
    gate: b[T.gate],
    flow: b[T.flow],
    lenPh: b[T.lenPh],
    lenOr: b[T.lenOr],
    lenNa: b[T.lenNa],
    frame,
    pharynx,
    oral,
    nasal,
    pharynxRms: take(nPh),
    oralRms: take(nOr),
    nasalRms: take(nNa),
  };
}
