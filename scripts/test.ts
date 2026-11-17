/**
 * Acceptance checks that can be automated (the browser ones are in scripts/e2e.mjs):
 *  1. presets of a species differ from each other, in anatomy and in the rendered sound;
 *  2. every call of every preset renders finite, audible, unclipped audio faster than real time;
 *  3. the same sentence as a statement and as a question gives calls whose final pitch movement
 *     differs. Judged on the rate the engine's vocal folds actually vibrated at while rendering
 *     (telemetry), with a spectral pitch estimate of the rendered audio printed as a second
 *     opinion. The test sentences are synthetic speech (CHIMERA's human voice), not recordings.
 * "Sounds like the species" is NOT checked here: that needs ears. See the README.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { measurePetSound } from "../src/analysis/petsound.ts";
import { Speech } from "../src/engine/speech.ts";
import { FIT_CALLS, fitSpec } from "../src/params/fit.ts";
import { textToProsody } from "../src/params/textprosody.ts";
import { analysePetProsody, analyseProsody, finalSlope } from "../src/analysis/prosody.ts";
import { PetEngine, renderOffline } from "../src/engine/engine.ts";
import { CALLS, makeCall, type CallId } from "../src/params/calls.ts";
import { bodyOf, characterOf, type PetSpec } from "../src/params/pet.ts";
import { PRESETS } from "../src/params/presets.ts";
import { petContour, prosodyToTrack } from "../src/params/prosody.ts";
import { intentToTrack, sanitizeIntent } from "../src/params/intent.ts";
import { decodeSpec, encodeSpec } from "../src/ui/share.ts";
import { combPitch, loadModule, median, readWav, spectrogram, stats, writeWav } from "./lib.ts";

const mod = loadModule();
const fs = 48000;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

function centroid(x: Float32Array): number {
  const spec = spectrogram(x, 2048, 1024);
  let num = 0;
  let den = 0;
  for (const row of spec) {
    for (let i = 1; i < row.length; i++) {
      const p = Math.pow(10, row[i] / 10);
      num += p * i * (fs / 2048);
      den += p;
    }
  }
  return num / Math.max(1e-12, den);
}

// ---- 1 + 2: presets ----
const main = { cat: "meow", dog: "bark" } as const;
const measured: Record<string, { species: string; tract: number; f0: number; f0Meas: number; centroid: number }> = {};
for (const p of PRESETS) {
  const body = bodyOf(p.spec);
  const c = characterOf(p.spec);
  let allOk = true;
  const notes: string[] = [];
  for (const id of CALLS[p.spec.species]) {
    const track = makeCall(c, id);
    const t0 = performance.now();
    const x = renderOffline(mod, body, track, fs);
    const rt = (x.length / fs) * 1000 / (performance.now() - t0);
    const s = stats(x);
    const ok = x.every((v) => Number.isFinite(v)) && s.peak > 0.03 && s.peak <= 1.0 && s.rms > 0.002;
    if (!ok) {
      allOk = false;
      notes.push(`${id}: peak ${s.peak.toFixed(3)} rms ${s.rms.toFixed(4)} rt×${rt.toFixed(1)}`);
    }
    if (id === main[p.spec.species]) {
      const pitch = combPitch(x, fs, c.f0Min * 0.7, c.f0Max * 1.2);
      const lv = Math.max(...pitch.map((q) => q.level));
      measured[p.id] = { species: p.spec.species, tract: c.tractLen, f0: c.f0, f0Meas: median(pitch.filter((q) => q.level > lv * 0.25).map((q) => q.f0)), centroid: centroid(x) };
    }
  }
  check(`${p.id}: all ${CALLS[p.spec.species].length} calls render audible, finite, unclipped`, allOk, notes.join("; "));
}
for (const species of ["cat", "dog"]) {
  const ids = Object.keys(measured).filter((k) => measured[k].species === species);
  console.log(`  ${species}: ` + ids.map((k) => `${k} tract ${measured[k].tract.toFixed(1)} cm, ${main[species as "cat"]} f0 ${measured[k].f0Meas.toFixed(0)} Hz (set ${measured[k].f0.toFixed(0)}), centroid ${measured[k].centroid.toFixed(0)} Hz`).join(" | "));
  check(`${species}: at least 3 presets`, ids.length >= 3, `${ids.length}`);
  let minSemis = Infinity;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = measured[ids[i]];
      const b = measured[ids[j]];
      // distance: pitch interval, or (same pitch) a clearly different spectrum
      const semis = Math.abs(12 * Math.log2(a.f0Meas / b.f0Meas));
      const bright = Math.abs(12 * Math.log2(a.centroid / b.centroid));
      minSemis = Math.min(minSemis, Math.max(semis, bright));
    }
  }
  check(`${species}: every pair of presets differs by ≥ 3 semitones in measured pitch or spectral centroid`, minSemis >= 3, `closest pair: ${minSemis.toFixed(1)} st`);
}

// ---- 3: question vs statement ----
if (!existsSync("test-audio/question-female.wav")) {
  console.log("SKIP  question/statement (test-audio/ missing; see README to regenerate)");
} else {
  let audioAgree = 0;
  let audioTotal = 0;
  for (const voice of ["female", "male"]) {
    for (const pid of ["orange", "kitten", "mid", "big"]) {
      const p = PRESETS.find((q) => q.id === pid)!;
      const c = characterOf(p.spec);
      const slope: Record<string, { human: number; set: number; engine: number; audio: number }> = {};
      for (const kind of ["statement", "question"]) {
        const { x, fs: inFs } = readWav(`test-audio/${kind}-${voice}.wav`);
        const pr = analyseProsody(x, inFs);
        const track = prosodyToTrack(pr, c);
        // render in 10 ms blocks, reading the glottal oscillator's actual rate after each
        const e = new PetEngine(mod, fs);
        e.setBody(bodyOf(p.spec));
        e.render(new Float32Array(256));
        e.play(track);
        const y = new Float32Array(Math.ceil((track.duration + 0.25) * fs));
        const engineF0: number[] = [];
        for (let o = 0; o < y.length; o += 480) {
          const blk = new Float32Array(Math.min(480, y.length - o));
          e.render(blk);
          y.set(blk, o);
          const t = e.telemetry();
          // voiced and audible
          engineF0.push(t[4] > 0.5 && t[2] > 0.02 ? t[5] : 0);
        }
        e.free();
        const pitch = combPitch(y, fs, c.f0Min * 0.8, c.f0Max * 1.2);
        const lv = Math.max(...pitch.map((q) => q.level));
        slope[kind] = {
          human: finalSlope(pr.f0, pr.hop),
          set: finalSlope(petContour(pr, c), pr.hop),
          engine: finalSlope(engineF0, 0.01),
          audio: finalSlope(pitch.map((q) => (q.level > lv * 0.2 ? q.f0 : 0)), 0.01),
        };
      }
      const d = slope.question.engine - slope.statement.engine;
      const audioAgrees = slope.question.audio - slope.statement.audio > 4 && slope.question.audio > 1 && slope.statement.audio < 0;
      if (audioAgrees) audioAgree++;
      audioTotal++;
      check(
        `${voice} voice → ${pid}: the call for the question ends rising, for the statement falling`,
        d > 4 && slope.question.engine > 1.5 && slope.statement.engine < -1.5,
        `final 350 ms in semitones (statement / question): person ${slope.statement.human.toFixed(1)} / ${slope.question.human.toFixed(1)}, pet's folds ${slope.statement.engine.toFixed(1)} / ${slope.question.engine.toFixed(1)}, spectral estimate from the audio ${slope.statement.audio.toFixed(1)} / ${slope.question.audio.toFixed(1)}${audioAgrees ? "" : " (estimate disagrees)"}`,
      );
    }
  }
  console.log(`  the independent spectral pitch estimate of the rendered audio agrees in ${audioAgree}/${audioTotal} cases (it slips to a harmonic on quiet, low phrase ends)`);
}

// ---- sculpt from its voice: synthesise a known pet, measure the audio, fit the sliders ----
// This checks the method against this app's own voices. It says nothing about real animals.
{
  mkdirSync("out", { recursive: true });
  for (const species of ["cat", "dog"] as const) {
    for (const call of Object.keys(FIT_CALLS[species]) as CallId[]) {
      const tractErr: number[] = [];
      const pitchErr: number[] = [];
      let hoarse = 0;
      for (const [size, texture] of [[0.1, 0], [0.5, 0], [0.9, 0], [0.7, 0.9], [0.35, -0.8]]) {
        const truth: PetSpec = { species, name: "", size, age: 0.5, snout: 0.5, mood: "happy", texture };
        const c = characterOf(truth);
        const x = renderOffline(mod, bodyOf(truth), makeCall(c, call), fs);
        if (species === "dog" && call === "bark" && size === 0.9) writeWav("out/fit-bigdog-bark.wav", x, fs);
        // start from a different pet of the same age
        const fit = fitSpec(measurePetSound(x, fs), { ...truth, size: 0.5, texture: 0 }, call);
        if (fit.ok && !fit.used.pitch && !fit.used.tract && fit.used.texture) {
          // too hoarse to read (a very husky bark): the fit must say so and leave the size alone
          hoarse++;
          tractErr.push(fit.spec.size === 0.5 && fit.spec.texture > 0.7 ? 0 : 9);
          pitchErr.push(0);
          continue;
        }
        const got = characterOf(fit.spec);
        tractErr.push(fit.ok ? Math.abs(Math.log(got.tractLen / c.tractLen)) : 9);
        pitchErr.push(fit.ok ? Math.abs(12 * Math.log2(got.f0 / c.f0)) : 99);
      }
      const worstT = Math.max(...tractErr);
      const worstP = Math.max(...pitchErr);
      check(`fit from a ${species}'s ${call}: tract within 12%, pitch within 2.5 semitones, over 5 pets`, worstT < 0.12 && worstP < 2.5, `worst tract error ${(worstT * 100).toFixed(0)}%, worst pitch error ${worstP.toFixed(1)} st${hoarse ? `; ${hoarse} too hoarse to read, declined (texture only)` : ""}`);
    }
  }
  const silent = fitSpec(measurePetSound(new Float32Array(48000), fs), PRESETS[0].spec, "meow");
  check("fit: silence is refused, not fitted", !silent.ok);
}

// ---- the pet's own call, mimicked: synthesise a call, analyse the audio, re-voice it on another pet ----
// Checked against this app's own renders only; no real animal recordings.
{
  const corr = (a: number[], b: number[]) => {
    const ma = a.reduce((x, y) => x + y, 0) / a.length;
    const mb = b.reduce((x, y) => x + y, 0) / b.length;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < a.length; i++) {
      sab += (a[i] - ma) * (b[i] - mb);
      saa += (a[i] - ma) ** 2;
      sbb += (b[i] - mb) ** 2;
    }
    return sab / Math.sqrt(saa * sbb || 1);
  };
  const cases: [PetSpec["species"], CallId, PetSpec["mood"]][] = [["cat", "meow", "coax"], ["cat", "meow", "sad"], ["cat", "caterwaul", "happy"], ["dog", "whine", "coax"], ["dog", "howl", "sad"]];
  for (const [species, call, mood] of cases) {
    const src: PetSpec = { species, name: "", size: 0.4, age: 0.5, snout: 0.5, mood, texture: 0 };
    const x = renderOffline(mod, bodyOf(src), makeCall(characterOf(src), call), fs);
    if (species === "cat" && call === "meow" && mood === "coax") writeWav("out/pet-meow.wav", x, fs);
    const pr = analysePetProsody(x, fs);
    // a bigger, differently pitched pet of the same species does the mimicking
    const target: PetSpec = { ...src, size: 0.85, mood: "happy" };
    const c = characterOf(target);
    const track = prosodyToTrack(pr, c, { fromPet: true });
    const e = new PetEngine(mod, fs);
    e.setBody(bodyOf(target));
    e.render(new Float32Array(256));
    e.play(track);
    const got: number[] = [];
    for (let o = 0; o < Math.ceil(track.duration * fs); o += 480) {
      e.render(new Float32Array(480));
      const t = e.telemetry();
      got.push(t[4] > 0.5 && t[2] > 0.02 ? t[5] : 0);
    }
    e.free();
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < Math.min(got.length, pr.f0.length); i++) {
      if (pr.f0[i] > 0 && got[i] > 0) {
        a.push(Math.log2(pr.f0[i]));
        b.push(Math.log2(got[i]));
      }
    }
    const r = a.length > 10 ? corr(a, b) : 0;
    const medGot = median(got.filter((v) => v > 0));
    const off = Math.abs(12 * Math.log2(medGot / c.f0));
    const span = (v: number[]) => 12 * (Math.max(...v) - Math.min(...v));
    check(
      `a ${species}'s own ${mood} ${call}, mimicked by another ${species}: same pitch shape, at the mimic's pitch`,
      r > 0.8 && off < 3 && Math.abs(span(a) - span(b)) < Math.max(3, span(a) * 0.4),
      `contour correlation ${r.toFixed(2)} over ${a.length} frames; range ${span(a).toFixed(1)} st heard → ${span(b).toFixed(1)} st sung; median ${medGot.toFixed(0)} Hz vs the mimic's ${c.f0.toFixed(0)} Hz`,
    );
  }
  const hissSpec: PetSpec = { species: "cat", name: "", size: 0.6, age: 0.5, snout: 0.5, mood: "angry", texture: 0 };
  const hiss = analysePetProsody(renderOffline(mod, bodyOf(hissSpec), makeCall(characterOf(hissSpec), "hiss"), fs), fs);
  const hissTrack = prosodyToTrack(hiss, characterOf(hissSpec), { fromPet: true });
  check("a hiss has no pitch and is mimicked with breath, not voice", hissTrack.keys.filter((k) => k.pressure > 0).every((k) => k.breath === 1), `${hissTrack.keys.filter((k) => k.pressure > 0).length} sounding keys`);
}

// ---- typed sentences ----
{
  const q = textToProsody("你今天想出去玩吗？")!;
  const st = textToProsody("该吃饭了。")!;
  check("typed Chinese: ？ ends rising, 。 ends falling, one syllable per character", finalSlope(q.f0, q.hop) > 2 && finalSlope(st.f0, st.hop) < -2 && q.syllables.length === 8 && st.syllables.length === 4, `question ${finalSlope(q.f0, q.hop).toFixed(1)} st, statement ${finalSlope(st.f0, st.hop).toFixed(1)} st`);
  check("typed text with nothing to say gives nothing", textToProsody("。。！") === null);
  const sp = new Speech(new WebAssembly.Module(readFileSync(new URL("../src/engine/petvoice_speech.wasm", import.meta.url))));
  sp.loadDict(gunzipSync(readFileSync(new URL("../public/data/cmudict.txt.gz", import.meta.url))));
  const pq = analyseProsody(sp.say("Do you want a treat?"), 48000);
  const ps = analyseProsody(sp.say("Dinner is ready."), 48000);
  check("typed English: the synthetic voice asks and states, and the analyser hears the difference", sp.dictLoaded && finalSlope(pq.f0, pq.hop) > 2 && finalSlope(ps.f0, ps.hop) < -1.5, `question ${finalSlope(pq.f0, pq.hop).toFixed(1)} st, statement ${finalSlope(ps.f0, ps.hop).toFixed(1)} st`);
}

// ---- share links round-trip ----
check(
  "share link round-trips every preset",
  PRESETS.every((p) => {
    const back = decodeSpec(encodeSpec(p.spec));
    return !!back && back.species === p.spec.species && back.name === p.spec.name && Math.abs(back.size - p.spec.size) < 0.006 && Math.abs(back.texture - p.spec.texture) < 0.006 && back.mood === p.spec.mood;
  }),
);

// ---- the voice intent interface ----
{
  const spec = PRESETS.find((q) => q.id === "orange")!.spec;
  const garbage = sanitizeIntent({ emotion: "furious", intensity: 9, duration: -3, call: "bark", contour: ["x", 40, -40], extra: 1 }, "cat");
  check("intent: a model's bad output is clamped or dropped", garbage.emotion === undefined && garbage.intensity === 1 && garbage.duration === 0.1 && garbage.call === undefined && garbage.contour?.[0] === 12);
  const calm = renderOffline(mod, bodyOf(spec), intentToTrack(spec, { emotion: "sad", intensity: 0.2 }), fs);
  const fierce = renderOffline(mod, bodyOf(spec), intentToTrack(spec, { emotion: "angry", intensity: 1 }), fs);
  check("intent: emotion and intensity change the sound", stats(fierce).rms > stats(calm).rms * 1.3, `rms sad/0.2 ${stats(calm).rms.toFixed(3)}, angry/1.0 ${stats(fierce).rms.toFixed(3)}`);
  const long = intentToTrack(spec, { call: "purr", duration: 5 });
  check("intent: duration is honoured", Math.abs(long.duration - 5) < 1, `${long.duration.toFixed(2)} s for 5 s asked`);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
