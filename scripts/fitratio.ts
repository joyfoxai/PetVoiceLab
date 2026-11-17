/** Measured pitch ÷ the character's pitch, and measured tract ÷ the body's, per call: the numbers in FIT_CALLS. */
import { bodyOf, characterOf, type PetSpec } from "../src/params/pet.ts";
import { makeCall, type CallId } from "../src/params/calls.ts";
import { measurePetSound } from "../src/analysis/petsound.ts";
import { renderOffline } from "../src/engine/engine.ts";
import { loadModule } from "./lib.ts";

const mod = loadModule();
const fs = 48000;
const calls: Record<string, CallId[]> = { cat: ["meow", "mew", "yowl", "growl"], dog: ["bark", "woof", "howl", "growl"] };
for (const species of ["cat", "dog"] as const) {
  for (const call of calls[species]) {
    const rows: string[] = [];
    for (const [size, texture] of [[0.1, 0], [0.5, 0], [0.9, 0], [0.7, 0.9], [0.35, -0.8]]) {
      const truth: PetSpec = { species, name: "", size, age: 0.5, snout: 0.5, mood: "happy", texture };
      const c = characterOf(truth);
      const m = measurePetSound(renderOffline(mod, bodyOf(truth), makeCall(c, call), fs), fs);
      rows.push(`${(m.f0 / c.f0).toFixed(2)}/${(m.tractLen / c.tractLen).toFixed(2)}/${m.kind[0]}/${m.hnr.toFixed(0)}`);
    }
    console.log(species, call.padEnd(6), "f0 ratio / tract ratio / kind / hnr:", rows.join("  "));
  }
}
