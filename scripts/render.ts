/**
 * Render every preset's calls to out/*.wav with a spectrogram sheet per preset, and print level,
 * pitch and timing. This is the tuning loop: `npm run render [presetId]`.
 */
import { mkdirSync } from "node:fs";
import { renderOffline } from "../src/engine/engine.ts";
import { CALLS, makeCall } from "../src/params/calls.ts";
import { bodyOf, characterOf, firstFormant } from "../src/params/pet.ts";
import { PRESETS } from "../src/params/presets.ts";
import { trackPitch } from "../src/analysis/yin.ts";
import { loadModule, median, stats, writeSpectrogramSheet, writeWav } from "./lib.ts";

const mod = loadModule();
const fs = 48000;
mkdirSync("out", { recursive: true });
const only = process.argv[2];
for (const p of PRESETS) {
  if (only && p.id !== only) continue;
  const body = bodyOf(p.spec);
  const c = characterOf(p.spec);
  console.log(`\n${p.id} (${p.label}): tract ${c.tractLen.toFixed(1)} cm (ph ${body.pharynxLen.toFixed(1)} + oral ${body.oralLen.toFixed(1)}), F1≈${firstFormant(c.tractLen).toFixed(0)} Hz, f0 ${c.f0.toFixed(0)} Hz, P ${c.pressure.toFixed(1)}, fold ${body.foldArea.toFixed(3)}`);
  const items: { x: Float32Array }[] = [];
  for (const id of CALLS[p.spec.species]) {
    const track = makeCall(c, id);
    const t0 = performance.now();
    const x = renderOffline(mod, body, track, fs);
    const ms = performance.now() - t0;
    const s = stats(x);
    const pitch = trackPitch(x, { sampleRate: fs, fMin: id === "purr" ? 15 : Math.max(30, c.f0Min * 0.2), fMax: Math.min(4000, c.f0Max * 2) }, 480);
    const voiced = pitch.filter((f) => f.clarity > 0.7 && f.rms > s.peak * 0.05).map((f) => f.f0);
    console.log(`  ${id.padEnd(6)} ${track.duration.toFixed(2)}s  peak ${s.peak.toFixed(3)} rms ${s.rms.toFixed(3)}  f0 med ${median(voiced).toFixed(0)} Hz (${voiced.length}/${pitch.length} voiced)  rt×${((x.length / fs) * 1000 / ms).toFixed(1)}`);
    writeWav(`out/${p.id}-${id}.wav`, x, fs);
    items.push({ x });
  }
  writeSpectrogramSheet(`out/${p.id}.png`, items, fs);
}
