/**
 * Calibration against real recordings. `npx tsx scripts/realcal.ts <dir>` where <dir> holds
 * keep.json and audio/ (CC0 / CC-BY cat and dog clips from ESC-50; see README). The audio stays
 * outside this repository; only the numbers measured here are written down.
 * Prints, per species: the real calls' features (median and quartiles) next to this app's.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderOffline } from "../src/engine/engine.ts";
import { makeCall, type CallId } from "../src/params/calls.ts";
import { bodyOf, characterOf, type PetSpec } from "../src/params/pet.ts";
import { features, med, quart, splitCalls, BANDS, CONTOUR, type CallFeatures } from "./features.ts";
import { loadModule, readWav } from "./lib.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: realcal.ts <dir with keep.json and audio/>");
const mod = loadModule();
const keep = JSON.parse(readFileSync(join(dir, "keep.json"), "utf8")) as { file: string; species: "cat" | "dog"; title: string }[];

const KEYS = [["duration", 2], ["attack", 3], ["release", 3], ["voiced", 2], ["f0", 0], ["f0Range", 1], ["jitter", 0], ["hnr", 1], ["clarity", 2], ["centroid", 0], ["tilt", 1], ["levelStd", 1]] as const;

/** Real calls of a species, cached as JSON next to the audio (re-measuring takes a while). */
function realCalls(species: "cat" | "dog"): CallFeatures[] {
  const cache = join(dir, `features-${species}.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")) as CallFeatures[];
  const out: CallFeatures[] = [];
  for (const k of keep.filter((q) => q.species === species)) {
    const { x, fs } = readWav(join(dir, "audio", k.file));
    for (const c of splitCalls(x, fs).slice(0, 6)) {
      const f = features(c, fs);
      // a call, not a click or a long stretch of noise
      if (f && f.duration >= 0.08 && f.duration <= 3) out.push(f);
    }
  }
  writeFileSync(cache, JSON.stringify(out));
  return out;
}

/** Our calls for the same job, padded so the splitter sees whole calls. */
function ourCalls(species: "cat" | "dog", call: CallId): CallFeatures[] {
  const out: CallFeatures[] = [];
  // a spread of pets, as the recordings are of many different animals
  for (const [size, snout, age] of [[0.1, 0.3, 0.5], [0.3, 0.7, 0.5], [0.5, 0.5, 0.5], [0.7, 0.2, 0.5], [0.9, 0.6, 0.5], [0.4, 0.5, 0.25], [0.6, 0.4, 0.8]]) {
    for (const mood of ["happy", "coax", "curious", "excited"] as const) {
      const spec: PetSpec = { species, name: "", size, age, snout, mood, texture: 0 };
      const y = renderOffline(mod, bodyOf(spec), makeCall(characterOf(spec), call), 48000);
      const padded = new Float32Array(y.length + 19200);
      padded.set(y, 9600);
      for (const c of splitCalls(padded, 48000)) {
        const f = features(c, 48000);
        if (f) out.push(f);
      }
    }
  }
  return out;
}

let grand = 0;
for (const species of ["cat", "dog"] as const) {
  const call: CallId = species === "cat" ? "meow" : "bark";
  const real = realCalls(species);
  const ours = ourCalls(species, call);
  console.log(`\n=== ${species} ${call}: ${real.length} real calls, ${ours.length} of ours ===`);
  console.log("  feature        real q25   median      q75 |     ours |  off by (in real quartile-widths)");
  let score = 0;
  for (const [k, d] of KEYS) {
    const r = real.map((x) => x[k]);
    const o = med(ours.map((x) => x[k]));
    const iqr = Math.max(1e-9, quart(r, 0.75) - quart(r, 0.25));
    const z = (o - med(r)) / iqr;
    score += Math.min(4, Math.abs(z));
    console.log(`  ${k.padEnd(10)} ${quart(r, 0.25).toFixed(d).padStart(10)} ${med(r).toFixed(d).padStart(8)} ${quart(r, 0.75).toFixed(d).padStart(8)} | ${o.toFixed(d).padStart(8)} | ${z >= 0 ? "+" : ""}${z.toFixed(1)}${Math.abs(z) > 1 ? "  <<" : ""}`);
  }
  // Bands from 430 Hz up, each set re-centred on its own mean. Below that the recordings hold
  // mostly room and handling noise (their level does not follow the call), which a dry render
  // has none of; counting it would only reward adding rumble.
  const B0 = 6;
  const centre = (v: number[]) => {
    const m = v.slice(B0).reduce((a, b) => a + b, 0) / (BANDS - B0);
    return v.map((x) => x - m);
  };
  const rb = centre(Array.from({ length: BANDS }, (_, i) => med(real.map((x) => x.bands[i]))));
  const ob = centre(Array.from({ length: BANDS }, (_, i) => med(ours.map((x) => x.bands[i]))));
  const bandErr = Math.sqrt(rb.slice(B0).reduce((a, v, i) => a + (v - ob[B0 + i]) ** 2, 0) / (BANDS - B0));
  console.log(`  spectrum, 24 bands 150 Hz–10 kHz (dB; compared from 430 Hz up, band 6 on); RMS difference ${bandErr.toFixed(1)} dB`);
  console.log("    real " + rb.map((v) => v.toFixed(0).padStart(4)).join(""));
  console.log("    ours " + ob.map((v) => v.toFixed(0).padStart(4)).join(""));
  console.log("    contour real " + Array.from({ length: CONTOUR }, (_, i) => med(real.filter((x) => x.f0 > 0).map((x) => x.contour[i])).toFixed(1)).join(" "));
  console.log("    contour ours " + Array.from({ length: CONTOUR }, (_, i) => med(ours.filter((x) => x.f0 > 0).map((x) => x.contour[i])).toFixed(1)).join(" "));
  score += bandErr / 3;
  console.log(`  distance score ${score.toFixed(1)} (lower is closer)`);
  grand += score;
}
console.log(`\ntotal ${grand.toFixed(1)}`);
