/**
 * "Sculpt from its voice": measurements of a recorded call → the sliders that would make a pet
 * with that pitch and that vocal tract length.
 *
 * A search over the (size, age) grid with the parameter layer's own forward model finds the
 * sliders whose tract length and pitch match the recording. In this model the two measurements
 * are nearly redundant (pitch is close to a function of tract length alone), so they pin the
 * tract and the pitch but not which of size and age produced them: age stays where the user put
 * it unless the measurements cannot be reached there. Texture comes from how noisy the voice is.
 * The muzzle slider cannot be heard and is left alone. The user says which call was recorded.
 *
 * EMPIRICAL: the bias factors below were set so that calls synthesised by this app are recovered
 * (scripts/test.ts round trip). They have not been checked against recordings of real animals.
 */
import type { PetSoundMeasure } from "../analysis/petsound.ts";
import type { CallId } from "./calls.ts";
import { characterOf, type PetSpec, type Species } from "./pet.ts";

export interface FitResult {
  ok: boolean;
  spec: PetSpec;
  /** which sliders the recording actually determined */
  used: { pitch: boolean; tract: boolean; texture: boolean };
  /** the tract length the fit settled on, cm (0: not used) */
  tractLen: number;
  /** why it failed, or what to keep in mind */
  note: string;
}

/**
 * The calls a recording can be declared as, with the ratio of its measured median pitch to the
 * pet's nominal pitch (EMPIRICAL: measured on this app's own renders; `null` = the call has no
 * usable pitch, only its resonances count). Calls not listed here did not survive the round trip.
 */
export const FIT_CALLS: Record<Species, Partial<Record<CallId, number | null>>> = {
  cat: { meow: 1.05, mew: 1.42, yowl: null, growl: null },
  dog: { bark: 1.42, woof: 0.69, howl: 2.95, growl: null },
};
/** measured tract length ÷ the body's tract length (an open mouth shifts the resonances) */
const TRACT_BIAS: Record<Species, number> = { cat: 1.02, dog: 1.06 };

function textureFrom(m: PetSoundMeasure, species: Species): number {
  // EMPIRICAL thresholds on the harmonics-to-noise ratio; barks are noisy to begin with
  const [clean, harsh] = species === "cat" ? [30, 12] : [12.5, 5];
  const t = (clean - m.hnr) / (clean - harsh);
  return Math.round(Math.max(-0.2, Math.min(1, -0.2 + 1.2 * t)) * 100) / 100;
}

export function fitSpec(m: PetSoundMeasure, base: PetSpec, call: CallId): FitResult {
  const species = base.species;
  const fail = (note: string): FitResult => ({ ok: false, spec: base, used: { pitch: false, tract: false, texture: false }, tractLen: 0, note });
  if (m.activeSeconds < 0.12) return fail("录到的声音太短或太轻。");
  const factor = FIT_CALLS[species][call] ?? null;
  const usePitch = factor !== null && m.kind === "tonal" && m.f0 > 0;
  // breath noise is made at the mouth, not at the folds, so its spectrum is not the whole tract's
  const candidates = m.kind === "noisy" ? [] : m.tractCandidates.filter((c) => c.weight > 0.5);
  if (!usePitch && !candidates.length) return fail("没听出音高，也没听出清楚的共鸣。换一段叫声试试（猫：喵、嚎、呼噜；狗：汪、低吼）。");
  // only the plain calls have a known "clean" level to compare with
  const useTexture = usePitch && m.hnr !== 0 && (call === "meow" || call === "mew" || call === "bark");
  const texture = useTexture ? textureFrom(m, species) : base.texture;

  // A very hoarse bark has no steady pitch to read: the two folds are out of step and the
  // period keeps breaking, and the noise buries the resonances too. Say so instead of guessing.
  if ((call === "bark" || call === "woof") && useTexture && m.hnr < 4) {
    return { ok: true, spec: { ...base, texture }, used: { pitch: false, tract: false, texture: true }, tractLen: 0, note: "这一声太沙哑，音高和共鸣都读不稳，只调了音色，体型没动。换一声干净点的再试。" };
  }

  let best = { cost: Infinity, size: base.size, age: base.age, tract: 0 };
  for (let age = 0.02; age <= 0.6001; age += 0.02) {
    for (let size = 0; size <= 1.0001; size += 0.02) {
      const c = characterOf({ ...base, size, age, texture });
      // Age cannot be heard in this model: a young animal and a small adult with the same tract
      // have nearly the same pitch. So the age the user set stays unless no size at that age
      // reaches the measurements (a kitten-sized tract).
      let cost = 6 * (age - Math.min(0.6, base.age)) * (age - Math.min(0.6, base.age)) + 0.05 * (size - 0.5) * (size - 0.5);
      if (usePitch) {
        // A harsh call (a bark) can lock into period doubling, and then the pitch measured is an octave
        // under the one the folds were set to. Allow that reading at a small price; the tract
        // length decides between the two.
        const e1 = Math.log(m.f0 / (c.f0 * (factor as number)));
        const e2 = Math.log((2 * m.f0) / (c.f0 * (factor as number)));
        const harsh = call === "bark" || call === "woof";
        cost += harsh ? Math.min((e1 * e1) / (0.1 * 0.1), (e2 * e2) / (0.1 * 0.1) + 1.5) : (e1 * e1) / (0.1 * 0.1);
      }
      let tract = 0;
      // Resonances can only be read off a voice whose harmonics fall closer together than they do
      // (a tube's resonances are c / 2L apart). A bark or a howl is pitched too high for that in
      // a dog-sized tract, and what the spectrum then suggests is a tract half as long. For a pet
      // where that would be so, the pitch alone decides.
      const readable = !usePitch || m.f0 < 17500 / c.tractLen / 2.2;
      if (candidates.length && readable) {
        let bestT = Infinity;
        for (const cand of candidates) {
          const e = Math.log(cand.tractLen / (c.tractLen * TRACT_BIAS[species]));
          const t = (e * e) / (0.07 * 0.07) + 6 * (1 - cand.weight);
          if (t < bestT) {
            bestT = t;
            tract = cand.tractLen;
          }
        }
        // a length no slider setting reaches should not outvote the pitch
        cost += Math.min(bestT, 12);
        if (bestT >= 12) tract = 0;
      }
      if (cost < best.cost) best = { cost, size, age, tract };
    }
  }
  const round = (x: number) => Math.round(x * 100) / 100;
  // an old pet keeps its age slider unless the fit had to move it
  const age = base.age > 0.6 && Math.abs(best.age - 0.6) < 0.011 ? base.age : round(best.age);
  const spec: PetSpec = { ...base, size: round(best.size), age, texture };
  const used = { pitch: usePitch, tract: best.tract > 0, texture: useTexture };
  let note = "";
  if (usePitch && !used.tract) note = "共鸣不够清楚，体型只按音高估。";
  else if (!usePitch) note = "这种叫声没有可用的音高，只按共鸣估了声道长度。";
  return { ok: true, spec, used, tractLen: best.tract, note };
}
