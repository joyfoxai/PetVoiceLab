/**
 * The voice intent interface for a host application. It never touches audio or anatomy: it emits
 * a small JSON `VoiceIntent` ("how does the pet feel, how strongly, for how long"), and this file
 * turns it into a `VoiceTrack` for whatever body the user sculpted.
 *
 *   { "emotion": "coax", "intensity": 0.7, "duration": 1.2 }
 *   { "call": "purr", "duration": 4 }
 *   { "emotion": "happy", "contour": [0, 2, 5, 3], "duration": 0.9 }   // semitones over time
 */
import { CALLS, makeCall, MOOD_CALL, type CallId } from "./calls.ts";
import { characterOf, MOODS, type Mood, type PetSpec } from "./pet.ts";
import type { VoiceTrack } from "./protocol.ts";

export interface VoiceIntent {
  /** how the pet feels; picks breath, fold tension, noise and the default call */
  emotion?: Mood;
  /** 0..1 how strongly (default 0.7) */
  intensity?: number;
  /** seconds (default: the call's natural length). Series calls (bark, pant, purr) repeat to fill it. */
  duration?: number;
  /** a specific call instead of the emotion's default */
  call?: CallId;
  /** pitch offsets in semitones, spread evenly over the call (a tune to follow), max ±12 */
  contour?: number[];
}

/** Validate and clamp whatever a model produced. Unknown fields are dropped. */
export function sanitizeIntent(raw: unknown, species: PetSpec["species"]): VoiceIntent {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: VoiceIntent = {};
  if (typeof r.emotion === "string" && (MOODS as string[]).includes(r.emotion)) out.emotion = r.emotion as Mood;
  if (typeof r.intensity === "number" && Number.isFinite(r.intensity)) out.intensity = Math.min(1, Math.max(0, r.intensity));
  if (typeof r.duration === "number" && Number.isFinite(r.duration)) out.duration = Math.min(8, Math.max(0.1, r.duration));
  if (typeof r.call === "string" && (CALLS[species] as string[]).includes(r.call)) out.call = r.call as CallId;
  if (Array.isArray(r.contour)) {
    const c = r.contour.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).slice(0, 32);
    if (c.length >= 2) out.contour = c.map((x) => Math.min(12, Math.max(-12, x)));
  }
  return out;
}

/** An intent, for this pet → the track to hand to the sounding layer. */
export function intentToTrack(spec: PetSpec, intent: VoiceIntent): VoiceTrack {
  const c = characterOf({ ...spec, mood: intent.emotion ?? spec.mood });
  const call = intent.call && (CALLS[c.species] as string[]).includes(intent.call) ? intent.call : MOOD_CALL[c.species][c.mood];
  // intensity 0..1 → the calls' 0.4..1.3 force scale
  const track = makeCall(c, call, { intensity: 0.4 + 0.9 * (intent.intensity ?? 0.7), duration: intent.duration });
  const contour = intent.contour;
  if (contour && contour.length >= 2) {
    for (const k of track.keys) {
      const u = (k.t / Math.max(1e-6, track.duration)) * (contour.length - 1);
      const i = Math.min(contour.length - 2, Math.floor(u));
      const st = contour[i] + (contour[i + 1] - contour[i]) * (u - i);
      k.f0 = Math.min(c.f0Max * 1.5, Math.max(15, k.f0 * Math.pow(2, st / 12)));
    }
  }
  return track;
}
