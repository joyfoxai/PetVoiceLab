/** Unlimited peak level of the main call over the size/age grid, to fit pet.ts `outputGain`. */
import { PetEngine } from "../src/engine/engine.ts";
import { makeCall } from "../src/params/calls.ts";
import { bodyOf, characterOf, type PetSpec } from "../src/params/pet.ts";
import { loadModule, stats } from "./lib.ts";

const mod = loadModule();
for (const species of ["cat", "dog"] as const) {
  for (const age of [0.05, 0.5]) {
    for (const size of [0, 0.5, 1]) {
      for (const snout of [0, 1]) {
      const spec: PetSpec = { species, name: "", size, age, snout, mood: "happy", texture: 0 };
      const body = bodyOf(spec);
      const c = characterOf(spec);
      const row: string[] = [];
      for (const id of species === "cat" ? (["meow", "yowl", "purr"] as const) : (["bark", "howl", "growl"] as const)) {
        const e = new PetEngine(mod, 48000);
        e.setBody({ ...body, gain: 1 });
        e.setLevel(0.01);
        e.render(new Float32Array(256));
        const track = makeCall(c, id);
        e.play(track);
        const x = new Float32Array(Math.ceil(track.duration * 48000));
        e.render(x);
        e.free();
        row.push(`${id} ${(stats(x).peak * 100).toFixed(4)} (rms ${(stats(x).rms * 100).toFixed(4)})`);
      }
      console.log(`${species} age ${age} size ${size} snout ${snout} tract ${c.tractLen.toFixed(1)} f0 ${c.f0.toFixed(0)} | ${row.join(" | ")}`);
      }
    }
  }
}
