/**
 * Step 3 of the parameter layer: a person's prosody → the pet's call with the same tune.
 *
 * What carries over: the pitch contour (as intervals around the speaker's median, widened, placed
 * on the pet's own pitch), loudness (as breath pressure and mouth opening), pauses (silence) and
 * syllable rhythm (as mouth gestures). What does not: words. The pet's anatomy and character stay
 * exactly as sculpted; only how it uses them follows the speaker.
 */
import type { Prosody } from "../analysis/prosody.ts";
import { restFrame } from "./calls.ts";
import type { VoiceCharacter } from "./pet.ts";
import type { VoiceFrame, VoiceKey, VoiceTrack } from "./protocol.ts";

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * How much the speaker's intervals are widened. EMPIRICAL: people move about half an octave in
 * ordinary speech; a meow sweeps most of an octave, so the tune reads better stretched.
 */
export const PITCH_STRETCH: Record<VoiceCharacter["species"], number> = { cat: 1.7, dog: 1.5 };

/** One person's pitch (Hz) → this pet's pitch (Hz). */
export function mapPitch(c: VoiceCharacter, hz: number, medianHz: number, stretch = PITCH_STRETCH[c.species]): number {
  if (!(hz > 0) || !(medianHz > 0)) return c.f0;
  const semis = 12 * Math.log2(hz / medianHz) * stretch;
  return clamp(c.f0 * Math.pow(2, semis / 12), c.f0Min, c.f0Max);
}

/**
 * The pet's pitch contour for a prosody, per frame (Hz; 0 in pauses). Unvoiced stretches inside
 * a phrase are bridged (in log frequency): a cat cannot whisper a consonant, it keeps meowing.
 */
export function petContour(p: Prosody, c: VoiceCharacter, stretch?: number): Float32Array {
  const n = p.f0.length;
  const out = new Float32Array(n);
  let i = 0;
  while (i < n) {
    if (!p.active[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && p.active[j]) j++;
    // phrase [i, j): collect voiced anchors
    const anchors: number[] = [];
    for (let k = i; k < j; k++) if (p.f0[k] > 0) anchors.push(k);
    for (let k = i; k < j; k++) {
      let hz: number;
      if (!anchors.length) {
        hz = p.medianF0 || 0;
      } else if (k <= anchors[0]) {
        hz = p.f0[anchors[0]];
      } else if (k >= anchors[anchors.length - 1]) {
        hz = p.f0[anchors[anchors.length - 1]];
      } else {
        let a = 0;
        while (anchors[a + 1] < k) a++;
        const k0 = anchors[a];
        const k1 = anchors[a + 1];
        const u = k1 === k0 ? 0 : (k - k0) / (k1 - k0);
        hz = p.f0[k0] * Math.pow(p.f0[k1] / p.f0[k0], u);
      }
      out[k] = mapPitch(c, hz, p.medianF0, stretch);
    }
    i = j;
  }
  // light smoothing (30 ms) so frame-to-frame pitch noise does not become warble
  const sm = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    if (!out[k]) continue;
    let a = 0;
    let w = 0;
    for (let d = -1; d <= 1; d++) {
      if (out[k + d] > 0) {
        a += Math.log(out[k + d]);
        w++;
      }
    }
    sm[k] = Math.exp(a / w);
  }
  return sm;
}

export interface ProsodyTrackOptions {
  /** 0..1.5 overall force (default 1) */
  intensity?: number;
  /**
   * The recording is an animal, not a person: intervals are kept as they are (no widening, only
   * the whole call moved to this pet's pitch), frames that were noisy in the recording are
   * voiced harshly, and stretches with no pitch at all (hisses, pants) become breath.
   */
  fromPet?: boolean;
}

/**
 * The call. Keys every 20 ms.
 *
 * Cats: each phrase is one long meow. The lips start shut on a hum (m), the tongue slides from
 * front (e) to back (o, u) across the phrase, and the jaw opens on every syllable and half-closes
 * between them, so five syllables come out as "m-ya-ow-ow-ow-ow".
 * Dogs: each syllable is its own "wuf" or "woo": lips round shut between syllables and the jaw
 * snaps open on each. Short loud syllables come out harsh (bark-like), long ones tonal (howl-like).
 */
export function prosodyToTrack(p: Prosody, c: VoiceCharacter, opts: ProsodyTrackOptions = {}): VoiceTrack {
  const amp = clamp(opts.intensity ?? 1, 0.3, 1.5);
  const contour = petContour(p, c, opts.fromPet ? 1 : undefined);
  const n = contour.length;
  const rest = restFrame(c);
  const keys: VoiceKey[] = [{ t: 0, ...rest }];
  const cat = c.species === "cat";
  const step = 2;
  let last: VoiceFrame = rest;

  // phrase bounds per frame, and syllable per frame
  const phraseStart = new Int32Array(n).fill(-1);
  const phraseEnd = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; ) {
    if (!p.active[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && p.active[j]) j++;
    for (let k = i; k < j; k++) {
      phraseStart[k] = i;
      phraseEnd[k] = j;
    }
    i = j;
  }
  const sylOf = new Int32Array(n).fill(-1);
  p.syllables.forEach((s, si) => {
    for (let k = Math.round(s.t0 / p.hop); k < Math.min(n, Math.round(s.t1 / p.hop)); k++) sylOf[k] = si;
  });

  for (let i = 0; i < n; i += step) {
    const t = (i + 0.5) * p.hop;
    if (!p.active[i] || !contour[i]) {
      // pause: breath off, mouth drifting shut
      const f: VoiceFrame = { ...last, pressure: 0, jaw: Math.min(last.jaw, 0.08), pulseDepth: 0 };
      keys.push({ t, ...f });
      last = f;
      continue;
    }
    const e = Math.sqrt(clamp(p.energy[i]));
    const ps = phraseStart[i];
    const pe = phraseEnd[i];
    const u = (i - ps) / Math.max(1, pe - ps); // 0..1 through the phrase
    const sinceStart = (i - ps) * p.hop;
    const toEnd = (pe - i) * p.hop;
    const syl = sylOf[i] >= 0 ? p.syllables[sylOf[i]] : null;
    // 0 at syllable edges, 1 at its loudest point
    let sylShape = 1;
    let sylLen = 0.3;
    if (syl) {
      sylLen = syl.t1 - syl.t0;
      const tt = i * p.hop;
      sylShape = tt < syl.peak ? (tt - syl.t0) / Math.max(0.03, syl.peak - syl.t0) : (syl.t1 - tt) / Math.max(0.03, syl.t1 - syl.peak);
      sylShape = Math.sin((Math.PI / 2) * clamp(sylShape));
    }
    const f: VoiceFrame = { ...rest, f0: contour[i], vibrato: c.vibrato };
    f.pressure = c.pressure * amp * lerp(0.5, 1.15, e) * clamp(toEnd / 0.05);
    if (cat) {
      const open = c.jawMax * lerp(0.35, 1, e) * lerp(0.45, 1, sylShape);
      // m: the first 70 ms of a phrase hums through the nose with the lips shut
      const m = clamp(sinceStart / 0.07);
      f.jaw = open * m * clamp(toEnd / 0.06 + 0.15);
      f.tonguePos = lerp(0.88, 0.15, Math.pow(u, 0.8));
      // high tongue at the start (e) and end (u), flat in the middle (a)
      f.tongueHeight = lerp(0.6, 0.12, Math.sin(Math.PI * clamp(u * 1.15))) * lerp(1, 0.75, sylShape);
      f.round = clamp((u - 0.55) / 0.45) * 0.8;
    } else {
      const short = clamp((0.32 - sylLen) / 0.2); // 1 for a clipped syllable, 0 for a held one
      f.jaw = c.jawMax * lerp(0.3, 1, e) * sylShape;
      f.round = lerp(0.75, 0.15 + 0.45 * (1 - short), sylShape);
      f.tonguePos = lerp(0.25, 0.42, sylShape);
      f.tongueHeight = lerp(0.45, 0.14, sylShape);
      f.rough = clamp(c.rough + short * (0.2 + 0.25 * e));
      f.tension = clamp(c.tension + 0.12 * short);
      f.pressure *= lerp(1, 1.35, short);
      f.larynx = 0.25 * (1 - short);
    }
    if (opts.fromPet) {
      let voicedInPhrase = false;
      for (let k = ps; k < pe && !voicedInPhrase; k++) voicedInPhrase = p.f0[k] > 0;
      if (!voicedInPhrase) {
        // no pitch anywhere in this stretch: a hiss or a pant, made with breath alone
        f.breath = 1;
        f.hiss = 0.8;
        f.pressure *= 1.6;
        f.tongueHeight = 0.7;
        f.tonguePos = 0.75;
      } else if (p.clarity) {
        // clean in the recording → clean here; noisy → pushed toward subharmonics and chaos
        f.rough = clamp(Math.max(f.rough, c.rough + (0.85 - p.clarity[i]) * 1.3));
      }
    }
    keys.push({ t, ...f });
    last = f;
  }
  const end = Math.max(p.duration, keys[keys.length - 1].t + 0.02);
  keys.push({ t: end, ...last, pressure: 0 });
  keys.push({ t: end + 0.1, ...rest });
  return { keys, duration: end + 0.1 };
}
