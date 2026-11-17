/** Real-time factor of the wasm engine per preset, after warm-up (sustained loud call). */
import { PetEngine } from "../src/engine/engine.ts";
import { makeCall } from "../src/params/calls.ts";
import { bodyOf, characterOf } from "../src/params/pet.ts";
import { PRESETS } from "../src/params/presets.ts";
import { loadModule } from "./lib.ts";

const mod = loadModule();
for (const fs of [48000, 44100]) {
  for (const p of PRESETS) {
    const e = new PetEngine(mod, fs);
    e.setBody(bodyOf(p.spec));
    const c = characterOf(p.spec);
    const track = makeCall(c, p.spec.species === "cat" ? "yowl" : "howl", { duration: 3 });
    const buf = new Float32Array(128);
    e.play(track, true);
    for (let i = 0; i < 400; i++) e.render(buf);
    const t0 = performance.now();
    const blocks = Math.round((fs * 4) / 128);
    let worst = 0;
    for (let i = 0; i < blocks; i++) {
      const a = performance.now();
      e.render(buf);
      worst = Math.max(worst, performance.now() - a);
    }
    const ms = performance.now() - t0;
    const tele = e.telemetry();
    console.log(`${fs} ${p.id.padEnd(7)} rt×${((blocks * 128 * 1000) / fs / ms).toFixed(1)}  load ${((ms / ((blocks * 128 * 1000) / fs)) * 100).toFixed(0)}%  worst block ${worst.toFixed(2)} ms (budget ${((128 / fs) * 1000).toFixed(2)})  nodes ph ${tele[7]} or ${tele[8]} na ${tele[9]}`);
    e.free();
  }
}
