/**
 * Offline renders off the main thread (voiceprint cards, WAV downloads): the same wasm engine,
 * faster than real time. Returns the samples and the engine's own state at the loudest moment,
 * so a card's cutaway is a real snapshot.
 */
import { PetEngine } from "../engine/engine.ts";
import { Speech, type SpeakerBody } from "../engine/speech.ts";
import type { VoiceBody, VoiceTrack } from "../params/protocol.ts";

/** English text → CHIMERA's human voice (48 kHz mono). */
export interface SpeakRequest {
  kind: "speak";
  id: number;
  wasmUrl: string;
  dictUrl: string;
  text: string;
  body: SpeakerBody;
}

export interface OfflineRequest {
  kind?: "render";
  id: number;
  wasm: ArrayBuffer;
  body: VoiceBody;
  track: VoiceTrack;
  sampleRate: number;
}
export interface OfflineResult {
  id: number;
  samples: Float32Array;
  /** telemetry block at the loudest moment */
  snapshot: Float32Array;
  sampleRate: number;
  error?: string;
  /** speak: whether the pronouncing dictionary was available (else letter-to-sound rules) */
  dict?: boolean;
}

let cached: { bytes: ArrayBuffer; module: WebAssembly.Module } | null = null;

let speech: Promise<Speech> | null = null;

async function loadSpeech(r: SpeakRequest): Promise<Speech> {
  const sp = new Speech(await WebAssembly.compile(await (await fetch(r.wasmUrl)).arrayBuffer()));
  try {
    // the dictionary ships gzipped; some servers already inflate .gz on the way
    const res = await fetch(r.dictUrl);
    if (!res.ok) throw new Error("no dictionary here");
    let bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    sp.loadDict(bytes);
  } catch {
    /* no dictionary: words are pronounced by rule, which is enough for the tune */
  }
  return sp;
}

async function speak(r: SpeakRequest): Promise<void> {
  const post = (res: OfflineResult, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(res, transfer);
  try {
    speech ??= loadSpeech(r);
    const sp = await speech;
    const samples = sp.say(r.text, r.body);
    post({ id: r.id, samples, snapshot: new Float32Array(0), sampleRate: 48000, dict: sp.dictLoaded }, [samples.buffer]);
  } catch (err) {
    speech = null;
    post({ id: r.id, samples: new Float32Array(0), snapshot: new Float32Array(0), sampleRate: 48000, error: String(err) });
  }
}

self.onmessage = (e: MessageEvent<OfflineRequest | SpeakRequest>) => {
  if (e.data.kind === "speak") {
    void speak(e.data);
    return;
  }
  const r = e.data;
  try {
    if (!cached || cached.bytes.byteLength !== r.wasm.byteLength) cached = { bytes: r.wasm, module: new WebAssembly.Module(r.wasm) };
    const eng = new PetEngine(cached.module, r.sampleRate);
    eng.setBody(r.body);
    eng.render(new Float32Array(256));
    eng.play(r.track);
    const total = Math.ceil((r.track.duration + 0.2) * r.sampleRate);
    const samples = new Float32Array(total);
    const block = new Float32Array(768);
    let best = -1;
    let snapshot = new Float32Array(0);
    for (let o = 0; o < total; o += block.length) {
      const n = Math.min(block.length, total - o);
      const b = n === block.length ? block : new Float32Array(n);
      eng.render(b);
      samples.set(b, o);
      const tele = eng.telemetry();
      if (tele[2] > best) {
        best = tele[2];
        snapshot = tele.slice();
      }
    }
    eng.free();
    const res: OfflineResult = { id: r.id, samples, snapshot, sampleRate: r.sampleRate };
    (self as unknown as Worker).postMessage(res, [samples.buffer, snapshot.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: r.id, samples: new Float32Array(0), snapshot: new Float32Array(0), sampleRate: r.sampleRate, error: String(err) } satisfies OfflineResult);
  }
};
