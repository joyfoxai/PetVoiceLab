/**
 * Ablation: what does each part actually contribute to the sound?
 * For every frame field, slider, mood and call, render with and without it and measure how far
 * the audio moves (mean absolute difference of a 40-band log spectrogram, in dB, after stretching
 * both renders to the same length). Under ~1 dB a listener is unlikely to notice; over ~3 dB is
 * a clearly different sound. This measures audio difference, not whether it sounds *right*.
 */
import { spectrogram } from "../src/analysis/fft.ts";
import { renderOffline } from "../src/engine/engine.ts";
import { CALLS, makeCall, restFrame, type CallId } from "../src/params/calls.ts";
import { bodyOf, characterOf, MOODS, type PetSpec, type Species } from "../src/params/pet.ts";
import { FRAME_KEYS, type VoiceTrack } from "../src/params/protocol.ts";
import { loadModule } from "./lib.ts";

const mod = loadModule();
const fs = 48000;
const BANDS = 40;

/** 40 log-spaced bands 100 Hz–12 kHz, dB, floored 60 dB under the render's peak; 64 time slots */
function fingerprint(x: Float32Array): Float32Array {
  const spec = spectrogram(x, 1024, 480);
  const edges = Array.from({ length: BANDS + 1 }, (_, i) => 100 * Math.pow(120, i / BANDS));
  const rows = spec.map((row) => {
    const out = new Float32Array(BANDS);
    for (let b = 0; b < BANDS; b++) {
      const lo = Math.max(1, Math.floor(edges[b] / (fs / 1024)));
      const hi = Math.max(lo + 1, Math.ceil(edges[b + 1] / (fs / 1024)));
      let p = 0;
      for (let i = lo; i < hi && i < row.length; i++) p += Math.pow(10, row[i] / 10);
      out[b] = 10 * Math.log10(p / (hi - lo) + 1e-12);
    }
    return out;
  });
  let peak = -200;
  for (const r of rows) for (const v of r) peak = Math.max(peak, v);
  const T = 64;
  const fp = new Float32Array(T * BANDS);
  for (let t = 0; t < T; t++) {
    const r = rows[Math.min(rows.length - 1, Math.floor(((t + 0.5) / T) * rows.length))] ?? new Float32Array(BANDS);
    for (let b = 0; b < BANDS; b++) fp[t * BANDS + b] = Math.max(r[b], peak - 60) - peak;
  }
  return fp;
}
/** shape distance in dB (levels normalised to each render's own peak) */
function distance(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}
const render = (spec: PetSpec, track: VoiceTrack) => fingerprint(renderOffline(mod, bodyOf(spec), track, fs));
const base = (species: Species): PetSpec => ({ species, name: "", size: 0.5, age: 0.5, snout: 0.5, mood: "happy", texture: 0 });
const fmt = (v: number) => v.toFixed(1).padStart(5);

console.log("== A. frame fields: each field frozen at its resting value, over every call (dB) ==");
for (const species of ["cat", "dog"] as const) {
  const spec = base(species);
  const c = characterOf(spec);
  const rest = restFrame(c);
  const rows: { key: string; mean: number; max: number; where: string; n: number }[] = [];
  const baseFp = new Map<CallId, Float32Array>();
  for (const id of CALLS[species]) baseFp.set(id, render(spec, makeCall(c, id)));
  for (const key of FRAME_KEYS) {
    if (key === "f0" || key === "pressure") continue; // without these there is no call at all
    let sum = 0;
    let max = 0;
    let where = "";
    let n = 0;
    for (const id of CALLS[species]) {
      const tr = makeCall(c, id);
      const frozen: VoiceTrack = { ...tr, keys: tr.keys.map((k) => ({ ...k, [key]: rest[key] })) };
      const d = distance(baseFp.get(id)!, render(spec, frozen));
      sum += d;
      if (d > max) {
        max = d;
        where = id;
      }
      if (d > 1) n++;
    }
    rows.push({ key, mean: sum / CALLS[species].length, max, where, n });
  }
  rows.sort((a, b) => b.max - a.max);
  console.log(species);
  for (const r of rows) console.log(`  ${r.key.padEnd(13)} mean ${fmt(r.mean)}  max ${fmt(r.max)} (${r.where})  audible in ${r.n}/${CALLS[species].length} calls`);
}

console.log("\n== B. sliders: 0.15 vs 0.85 (texture −0.7 vs +0.7), main calls (dB) ==");
for (const species of ["cat", "dog"] as const) {
  const calls: CallId[] = species === "cat" ? ["meow", "purr", "hiss"] : ["bark", "growl", "howl"];
  for (const key of ["size", "age", "snout", "texture"] as const) {
    const lo = { ...base(species), [key]: key === "texture" ? -0.7 : 0.15 };
    const hi = { ...base(species), [key]: key === "texture" ? 0.7 : 0.85 };
    const ds = calls.map((id) => distance(render(lo, makeCall(characterOf(lo), id)), render(hi, makeCall(characterOf(hi), id))));
    console.log(`  ${species} ${key.padEnd(8)} ${calls.map((id, i) => `${id} ${fmt(ds[i])}`).join("  ")}`);
  }
}

console.log("\n== C. moods: distance between every pair on the main call; closest pairs first (dB) ==");
for (const species of ["cat", "dog"] as const) {
  const id: CallId = species === "cat" ? "meow" : "bark";
  const fps = MOODS.map((m) => {
    const s = { ...base(species), mood: m };
    return render(s, makeCall(characterOf(s), id));
  });
  const pairs: [string, number][] = [];
  for (let i = 0; i < MOODS.length; i++) for (let j = i + 1; j < MOODS.length; j++) pairs.push([`${MOODS[i]}–${MOODS[j]}`, distance(fps[i], fps[j])]);
  pairs.sort((a, b) => a[1] - b[1]);
  console.log(`  ${species} ${id}: ` + pairs.slice(0, 6).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ") + ` … farthest ${pairs[pairs.length - 1][0]} ${pairs[pairs.length - 1][1].toFixed(1)}`);
}

console.log("\n== D. calls: closest pairs within a species (dB) ==");
for (const species of ["cat", "dog"] as const) {
  const spec = base(species);
  const c = characterOf(spec);
  const fps = CALLS[species].map((id) => render(spec, makeCall(c, id)));
  const pairs: [string, number][] = [];
  for (let i = 0; i < fps.length; i++) for (let j = i + 1; j < fps.length; j++) pairs.push([`${CALLS[species][i]}–${CALLS[species][j]}`, distance(fps[i], fps[j])]);
  pairs.sort((a, b) => a[1] - b[1]);
  console.log(`  ${species}: ` + pairs.slice(0, 6).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", "));
}
