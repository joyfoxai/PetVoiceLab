/**
 * The sounding layer on the audio thread: the wasm engine inside an AudioWorkletProcessor.
 * Messages apply between render quanta in arrival order. If the engine traps, the processor goes
 * silent and says so once.
 */
import { PetEngine } from "../engine/engine.ts";
import type { FromWorklet, ToWorklet } from "./protocol.ts";

declare const sampleRate: number;
declare const currentTime: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

/** telemetry every N render quanta (128 frames): ~62 Hz at 48 kHz */
const TELE_EVERY = 6;

class PetVoiceProcessor extends AudioWorkletProcessor {
  private engine: PetEngine | null = null;
  private failed = false;
  private blocks = 0;
  private load = 0;
  private busyMs = 0;
  private busyFrames = 0;
  private playId = 0;
  private awaitingOnset = false;
  private wasPlaying = false;
  private readonly mono = new Float32Array(128);

  constructor(options: { processorOptions: { wasm: ArrayBuffer } }) {
    super();
    try {
      // synchronous compile is fine off the main thread; the module is ~90 KB
      this.engine = new PetEngine(new WebAssembly.Module(options.processorOptions.wasm), sampleRate);
    } catch (err) {
      this.fail(err);
    }
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => {
      if (this.failed || !this.engine) return;
      try {
        this.handle(e.data);
      } catch (err) {
        this.fail(err);
      }
    };
  }

  private post(m: FromWorklet, transfer: Transferable[] = []): void {
    this.port.postMessage(m, transfer);
  }

  private fail(err: unknown): void {
    this.failed = true;
    this.post({ type: "error", message: String(err) });
  }

  private handle(m: ToWorklet): void {
    const e = this.engine!;
    switch (m.type) {
      case "body":
        e.setBodyPacked(m.body);
        break;
      case "live":
        e.setLivePacked(m.frame, m.gate);
        break;
      case "play":
        e.setLevel(m.level);
        e.playPacked(m.keys, m.loop);
        this.playId = m.id;
        this.awaitingOnset = true;
        this.wasPlaying = true;
        break;
      case "level":
        e.setLevel(m.level);
        break;
      case "economy":
        e.setEconomy(m.on);
        break;
      case "stop":
        e.stop();
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (this.failed || !this.engine || !out?.length) return true;
    const n = out[0].length;
    const buf = n === this.mono.length ? this.mono : new Float32Array(n);
    // AudioWorkletGlobalScope has no performance.now(); Date.now() is coarse (1 ms) but unbiased
    // when summed over many blocks
    const t0 = Date.now();
    try {
      this.engine.render(buf);
    } catch (err) {
      this.fail(err);
      return true;
    }
    for (const ch of out) ch.set(buf);
    if (this.awaitingOnset) {
      for (let i = 0; i < n; i++) {
        if (Math.abs(buf[i]) > 0.004) {
          this.awaitingOnset = false;
          this.post({ type: "onset", id: this.playId, time: (currentFrame + i) / sampleRate });
          break;
        }
      }
    }
    this.busyMs += Date.now() - t0;
    this.busyFrames += n;
    if (this.busyFrames >= sampleRate) {
      this.load = this.busyMs / ((this.busyFrames / sampleRate) * 1000);
      this.busyMs = 0;
      this.busyFrames = 0;
    }
    if (++this.blocks % TELE_EVERY === 0) {
      const tele = this.engine.telemetry();
      const copy = tele.slice();
      if (this.wasPlaying && copy[1] < 0) {
        this.wasPlaying = false;
        this.post({ type: "ended", id: this.playId, time: currentTime });
      }
      this.post({ type: "tele", time: currentTime, data: copy, load: this.load }, [copy.buffer]);
    }
    return true;
  }
}

/** Microphone capture: forwards mono PCM blocks to the main thread (pitch tracking runs there). */
class RecorderProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(2048);
  private fill = 0;
  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.fill++] = ch[i];
      if (this.fill === this.buf.length) {
        const data = this.buf;
        this.port.postMessage({ type: "pcm", data }, [data.buffer]);
        this.buf = new Float32Array(2048);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor("pet-voice", PetVoiceProcessor);
registerProcessor("pet-recorder", RecorderProcessor);
