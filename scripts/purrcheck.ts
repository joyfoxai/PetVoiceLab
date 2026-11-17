import { renderOffline } from "../src/engine/engine.ts";
import { makeCall } from "../src/params/calls.ts";
import { bodyOf, characterOf } from "../src/params/pet.ts";
import { PRESETS } from "../src/params/presets.ts";
import { loadModule } from "./lib.ts";
const mod = loadModule();
for (const id of ["kitten", "orange", "tom"]) {
  const p = PRESETS.find((q) => q.id === id)!;
  const x = renderOffline(mod, bodyOf(p.spec), makeCall(characterOf(p.spec), "purr"), 48000);
  // envelope (rectify + 10 ms box at 1 kHz), then autocorrelation over 10–80 Hz
  const env: number[] = [];
  for (let i = 0; i + 48 <= x.length; i += 48) {
    let a = 0;
    for (let j = 0; j < 48; j++) a += Math.abs(x[i + j]);
    env.push(a / 48);
  }
  const seg = env.slice(200, 900); // inside the first out-breath
  const m = seg.reduce((a, b) => a + b, 0) / seg.length;
  let best = 0, bestLag = 0, e0 = 0;
  for (const v of seg) e0 += (v - m) ** 2;
  for (let lag = 12; lag <= 100; lag++) {
    let s = 0;
    for (let i = 0; i + lag < seg.length; i++) s += (seg[i] - m) * (seg[i + lag] - m);
    s /= e0;
    if (s > best) { best = s; bestLag = lag; }
  }
  const depth = (Math.max(...seg) - Math.min(...seg)) / Math.max(...seg);
  // in-breath vs out-breath level
  const rms = (a: number, b: number) => Math.sqrt(x.subarray(a, b).reduce((s, v) => s + v * v, 0) / (b - a));
  console.log(id, "pulse rate", (1000 / bestLag).toFixed(1), "Hz  autocorr", best.toFixed(2), " depth", depth.toFixed(2), " out-breath rms", rms(9600, 38000).toFixed(3), " in-breath rms", rms(52000, 80000).toFixed(3));
}
