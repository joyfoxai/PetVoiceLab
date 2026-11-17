/**
 * How near is each of our calls to its nearest REAL call, next to how near real calls are to
 * each other? `npx tsx scripts/nearest.ts <dir>` (the same directory as realcal.ts).
 *
 * realcal.ts compares medians, and a median hides the thing an ear goes by: how the spectrum
 * moves through one call. Here every call becomes a small picture (log bands × time slices,
 * level taken out) and pictures are compared whole.
 *  - "real→real": for each real call, the distance to the nearest OTHER recording's call;
 *  - "ours→real": for each of our calls, the distance to the nearest real call.
 * If ours sit as near to a real call as real calls sit to each other, the numbers match.
 * Also prints the average picture of each, and where they differ most.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderOffline } from "../src/engine/engine.ts";
import { spectrogram } from "../src/analysis/fft.ts";
import { resample } from "../src/analysis/prosody.ts";
import { makeCall, type CallId } from "../src/params/calls.ts";
import { bodyOf, characterOf, type PetSpec } from "../src/params/pet.ts";
import { features, med, quart, splitCalls } from "./features.ts";
import { loadModule, readWav } from "./lib.ts";

const FS = 24000;
export const NB = 18; // 250 Hz – 8 kHz
export const NT = 8;
const F_LO = 250;
const F_HI = 8000;
const FLOOR = -36; // dB under the call's loudest cell

export interface Pic {
  src: string;
  v: number[]; // NB*NT, dB re the loudest cell, floored
  dur: number;
  f0: number;
  hnr: number;
  /** pitch at NT points, semitones from the call's median (NaN where unvoiced) */
  pitch: number[];
}

export function picture(input: Float32Array, fs: number, src: string): Pic | null {
  const f = features(input, fs);
  if (!f) return null;
  const x = resample(input, fs, FS);
  const spec = spectrogram(x, 1024, 120);
  // active span: within 20 dB of the loudest frame
  const lv = spec.map((r) => {
    let p = 0;
    for (let b = 10; b < 350; b++) p += Math.pow(10, r[b] / 10);
    return p;
  });
  const top = Math.max(...lv);
  const i0 = lv.findIndex((p) => p > top * 0.01);
  const i1 = lv.length - 1 - [...lv].reverse().findIndex((p) => p > top * 0.01);
  if (i1 - i0 < NT) return null;
  const binHz = FS / 1024;
  const v: number[] = [];
  for (let t = 0; t < NT; t++) {
    const a = i0 + Math.floor(((i1 - i0 + 1) * t) / NT);
    const b = i0 + Math.floor(((i1 - i0 + 1) * (t + 1)) / NT);
    for (let k = 0; k < NB; k++) {
      const lo = F_LO * Math.pow(F_HI / F_LO, k / NB);
      const hi = F_LO * Math.pow(F_HI / F_LO, (k + 1) / NB);
      let p = 0;
      let c = 0;
      for (let r = a; r < Math.max(a + 1, b); r++) {
        for (let i = Math.max(1, Math.floor(lo / binHz)); i < Math.ceil(hi / binHz); i++) {
          p += Math.pow(10, spec[r][i] / 10);
          c++;
        }
      }
      v.push(10 * Math.log10(p / Math.max(1, c) + 1e-14));
    }
  }
  const mx = Math.max(...v);
  return { src, v: v.map((q) => Math.max(FLOOR, q - mx)), dur: f.duration, f0: f.f0, hnr: f.hnr, pitch: f.contour.filter((_, i) => i < NT) };
}

export const dist = (a: Pic, b: Pic) => Math.sqrt(a.v.reduce((s, q, i) => s + (q - b.v[i]) ** 2, 0) / a.v.length);

export function realPics(dir: string, species: "cat" | "dog"): Pic[] {
  // cached next to the audio: measuring the recordings takes a while
  const cache = join(dir, `pictures-${species}.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")) as Pic[];
  const keep = JSON.parse(readFileSync(join(dir, "keep.json"), "utf8")) as { file: string; species: string }[];
  const out: Pic[] = [];
  for (const k of keep.filter((q) => q.species === species)) {
    const { x, fs } = readWav(join(dir, "audio", k.file));
    for (const c of splitCalls(x, fs).slice(0, 6)) {
      const p = picture(c, fs, k.file.split("-")[1]);
      if (p && p.dur >= 0.08 && p.dur <= 3) out.push(p);
    }
  }
  writeFileSync(cache, JSON.stringify(out));
  return out;
}

const SPREAD: [number, number, number][] = [[0.1, 0.3, 0.5], [0.3, 0.7, 0.5], [0.5, 0.5, 0.5], [0.7, 0.2, 0.5], [0.9, 0.6, 0.5], [0.4, 0.5, 0.25], [0.6, 0.4, 0.8]];
export function ourPics(mod: WebAssembly.Module, species: "cat" | "dog", call: CallId): Pic[] {
  const out: Pic[] = [];
  for (const [size, snout, age] of SPREAD) {
    for (const mood of ["happy", "coax", "curious", "excited"] as const) {
      const spec: PetSpec = { species, name: "", size, age, snout, mood, texture: 0 };
      const y = renderOffline(mod, bodyOf(spec), makeCall(characterOf(spec), call), 48000);
      const padded = new Float32Array(y.length + 19200);
      padded.set(y, 9600);
      for (const c of splitCalls(padded, 48000)) {
        const p = picture(c, 48000, `${size}/${mood}`);
        if (p) out.push(p);
      }
    }
  }
  return out;
}

const row = (v: number[]) => v.map((q) => q.toFixed(0).padStart(4)).join("");

function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: nearest.ts <dir with keep.json and audio/>");
  const mod = loadModule();
  let total = 0;
  for (const species of ["cat", "dog"] as const) {
    const call: CallId = species === "cat" ? "meow" : "bark";
    const real = realPics(dir, species);
    const ours = ourPics(mod, species, call);
    const rr = real.map((a) => Math.min(...real.filter((b) => b.src !== a.src).map((b) => dist(a, b))));
    const or = ours.map((a) => Math.min(...real.map((b) => dist(a, b))));
    console.log(`\n=== ${species} ${call}: ${real.length} real, ${ours.length} ours ===`);
    console.log(`  nearest-real distance, dB   q25  median   q75`);
    console.log(`    real → other real      ${quart(rr, 0.25).toFixed(1).padStart(5)} ${med(rr).toFixed(1).padStart(6)} ${quart(rr, 0.75).toFixed(1).padStart(6)}`);
    console.log(`    ours → real            ${quart(or, 0.25).toFixed(1).padStart(5)} ${med(or).toFixed(1).padStart(6)} ${quart(or, 0.75).toFixed(1).padStart(6)}`);
    total += med(or) / med(rr);
    // average pictures, time-averaged per band and band-averaged per time
    const mean = (ps: Pic[]) => Array.from({ length: NB * NT }, (_, i) => med(ps.map((p) => p.v[i])));
    const mr = mean(real);
    const mo = mean(ours);
    const band = (m: number[]) => Array.from({ length: NB }, (_, k) => Array.from({ length: NT }, (_, t) => m[t * NB + k]).reduce((a, b) => a + b, 0) / NT);
    const time = (m: number[]) => Array.from({ length: NT }, (_, t) => m.slice(t * NB, (t + 1) * NB).reduce((a, b) => a + b, 0) / NB);
    console.log(`  bands ${F_LO} Hz → ${F_HI} Hz, time-averaged (dB under the loudest cell)`);
    console.log("    real " + row(band(mr)));
    console.log("    ours " + row(band(mo)));
    console.log("  level through the call (8 slices)");
    console.log("    real " + row(time(mr)));
    console.log("    ours " + row(time(mo)));
    console.log(`  hnr  real ${med(real.map((p) => p.hnr)).toFixed(1)}  ours ${med(ours.map((p) => p.hnr)).toFixed(1)}   f0 real ${med(real.map((p) => p.f0)).toFixed(0)}  ours ${med(ours.map((p) => p.f0)).toFixed(0)}`);
  }
  console.log(`\nratio ours/real, summed over the two (2.0 would be indistinguishable by this measure): ${total.toFixed(2)}`);
}

if (process.argv[1]?.endsWith("nearest.ts")) main();
