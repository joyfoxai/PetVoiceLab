import type { VoiceBody, VoiceTrack } from "../params/protocol.ts";
import { engineBytes } from "./audio.ts";
import speechUrl from "../engine/petvoice_speech.wasm?url";
import type { SpeakerBody } from "../engine/speech.ts";
import type { OfflineRequest, OfflineResult, SpeakRequest } from "./offline.worker.ts";

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { resolve: (r: OfflineResult) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./offline.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<OfflineResult>) => {
      const w = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (e.data.error) w?.reject(new Error(e.data.error));
      else w?.resolve(e.data);
    };
  }
  return worker;
}

/** Render a track in a Worker, faster than real time. */
export async function renderInWorker(body: VoiceBody, track: VoiceTrack, sampleRate = 48000): Promise<OfflineResult> {
  const wasm = await engineBytes();
  const w = ensureWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.postMessage({ id, wasm, body, track, sampleRate } satisfies OfflineRequest);
  });
}

/** English text → speech in the Worker (the first call also loads the voice and its dictionary). */
export function speakInWorker(text: string, body: SpeakerBody = "female"): Promise<OfflineResult> {
  const w = ensureWorker();
  const id = ++seq;
  const abs = (u: string) => new URL(u, document.baseURI).href;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.postMessage({ kind: "speak", id, wasmUrl: abs(speechUrl), dictUrl: abs("./data/cmudict.txt.gz"), text, body } satisfies SpeakRequest);
  });
}

export function wavBlob(x: Float32Array, fs: number): Blob {
  const b = new DataView(new ArrayBuffer(44 + x.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  b.setUint32(4, 36 + x.length * 2, true);
  str(8, "WAVEfmt ");
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);
  b.setUint16(22, 1, true);
  b.setUint32(24, fs, true);
  b.setUint32(28, fs * 2, true);
  b.setUint16(32, 2, true);
  b.setUint16(34, 16, true);
  str(36, "data");
  b.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) b.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), true);
  return new Blob([b], { type: "audio/wav" });
}
