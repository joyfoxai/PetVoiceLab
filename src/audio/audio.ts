/**
 * Main-thread side of the sound: AudioContext, the worklet node, and telemetry timed to what is
 * being heard. Nothing is synthesised here. The context is created on the first user gesture
 * (autoplay rules), at 48 kHz where the browser allows it.
 */
import workletUrl from "../worklet/processor.ts?worker&url";
import wasmUrl from "../engine/petvoice.wasm?url";
import { decodeTelemetry, packBody, packFrame, packTrack, type Telemetry, type VoiceBody, type VoiceFrame, type VoiceTrack } from "../params/protocol.ts";
import type { FromRecorder, FromWorklet, ToWorklet } from "../worklet/protocol.ts";

let wasmBytes: Promise<ArrayBuffer> | null = null;
/** The engine's bytes (fetched once; also used by the offline worker). */
export function engineBytes(): Promise<ArrayBuffer> {
  wasmBytes ??= fetch(wasmUrl).then((r) => {
    if (!r.ok) throw new Error("engine download failed: " + r.status);
    return r.arrayBuffer();
  });
  return wasmBytes;
}

export interface PlayOptions {
  loop?: boolean;
  /** linear volume on top of the track's own microphone gain */
  volume?: number;
  onEnded?: () => void;
}

interface Stamped {
  time: number;
  tele: Telemetry;
}

export class PetAudio {
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private starting: Promise<void> | null = null;
  private queue: Stamped[] = [];
  private current: Telemetry | null = null;
  private pendingBody: VoiceBody | null = null;
  private playSeq = 0;
  private sent = new Map<number, number>();
  private ended = new Map<number, () => void>();
  /** master volume (after the engine) and a tap for recording */
  private master: GainNode | null = null;
  private tap: MediaStreamAudioDestinationNode | null = null;
  /** worklet render load 0..1 (smoothed) */
  load = 0;
  /** last measured touch→sound latency, ms (engine onset + output latency) */
  latencyMs = 0;
  /** draw telemetry without waiting for the output latency (while recording a video) */
  immediate = false;
  error: string | null = null;
  /** true once the engine was switched to its cheaper internal rate because of load */
  economy = false;
  private overloaded = 0;
  private lastLoad = -1;

  get running(): boolean {
    return !!this.node && this.ctx?.state === "running";
  }

  /** Call from a user gesture. Safe to call repeatedly. */
  start(): Promise<void> {
    if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume();
    this.starting ??= this.init().catch((err) => {
      this.starting = null;
      this.error = String(err?.message ?? err);
      throw err;
    });
    return this.starting;
  }

  private async init(): Promise<void> {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    let ctx: AudioContext;
    try {
      ctx = new Ctx({ sampleRate: 48000, latencyHint: "interactive" });
    } catch {
      ctx = new Ctx({ latencyHint: "interactive" });
    }
    this.ctx = ctx;
    // resume inside the gesture before any await (iOS Safari)
    const resumed = ctx.resume();
    const [bytes] = await Promise.all([engineBytes(), ctx.audioWorklet.addModule(workletUrl)]);
    const node = new AudioWorkletNode(ctx, "pet-voice", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { wasm: bytes.slice(0) } });
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => this.onMessage(e.data);
    node.onprocessorerror = () => (this.error = "audio processor crashed");
    this.master = ctx.createGain();
    node.connect(this.master);
    this.master.connect(ctx.destination);
    this.node = node;
    if (this.pendingBody) this.setBody(this.pendingBody);
    await resumed;
  }

  private send(m: ToWorklet, transfer: Transferable[] = []): void {
    this.node?.port.postMessage(m, transfer);
  }

  private onMessage(m: FromWorklet): void {
    switch (m.type) {
      case "tele":
        this.load = m.load;
        // a device that cannot keep up drops to the cheaper internal rate, once, and stays there
        // (the meter updates once a second; three overloaded seconds in a row, so one busy moment
        // such as an export does not cost the session its quality)
        if (m.load !== this.lastLoad) {
          this.lastLoad = m.load;
          this.overloaded = m.load > 0.8 && !this.immediate ? this.overloaded + 1 : 0;
        }
        if (this.overloaded >= 3 && !this.economy) {
          this.economy = true;
          this.send({ type: "economy", on: true });
        }
        this.queue.push({ time: m.time, tele: decodeTelemetry(m.data) });
        if (this.queue.length > 240) this.queue.splice(0, this.queue.length - 240);
        break;
      case "onset": {
        const at = this.sent.get(m.id);
        if (at !== undefined && this.ctx) {
          this.sent.delete(m.id);
          this.latencyMs = Math.max(0, (m.time - at) * 1000) + this.outputLatency() * 1000;
        }
        break;
      }
      case "ended": {
        const cb = this.ended.get(m.id);
        this.ended.delete(m.id);
        cb?.();
        break;
      }
      case "error":
        this.error = m.message;
        console.error("worklet:", m.message);
        break;
    }
  }

  /** seconds between a sample leaving the engine and being heard */
  outputLatency(): number {
    const c = this.ctx;
    if (!c) return 0;
    return (c.outputLatency || 0) + (c.baseLatency || 0);
  }

  setBody(b: VoiceBody): void {
    this.pendingBody = b;
    this.send({ type: "body", body: packBody(b) });
  }

  setLive(f: VoiceFrame, gate: number): void {
    this.send({ type: "live", frame: packFrame(f), gate });
  }

  play(track: VoiceTrack, o: PlayOptions = {}): number {
    const id = ++this.playSeq;
    if (this.ctx) this.sent.set(id, this.ctx.currentTime);
    if (o.onEnded) this.ended.set(id, o.onEnded);
    this.send({ type: "play", keys: packTrack(track), loop: !!o.loop, level: (o.volume ?? 1) * (track.mic ?? 1), id });
    return id;
  }

  stop(): void {
    this.ended.clear();
    this.send({ type: "stop" });
  }

  setMaster(v: number): void {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /** A stream of the pet's voice (plus anything connected to `recordInput`) for MediaRecorder. */
  recordingStream(): { stream: MediaStream; input: AudioNode } | null {
    if (!this.ctx || !this.master) return null;
    if (!this.tap) {
      this.tap = this.ctx.createMediaStreamDestination();
      this.master.connect(this.tap);
    }
    return { stream: this.tap.stream, input: this.tap };
  }

  /**
   * The engine state that matches what is being heard now: the newest snapshot at least one
   * output latency old. Returns the last one if nothing newer is due.
   */
  telemetry(): Telemetry | null {
    if (!this.ctx) return this.current;
    const now = this.ctx.currentTime - (this.immediate ? 0 : this.outputLatency());
    let i = -1;
    while (i + 1 < this.queue.length && this.queue[i + 1].time <= now) i++;
    if (i >= 0) {
      this.current = this.queue[i].tele;
      this.queue.splice(0, i + 1);
    }
    return this.current;
  }

  /** Open the microphone (prompts for permission); PCM blocks arrive on `onPcm` at `sampleRate`. */
  async openMic(onPcm: (x: Float32Array) => void, o: { raw?: boolean } = {}): Promise<{ sampleRate: number; stop: () => void }> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("getUserMedia unavailable");
    // ask first, inside the click: this is what raises the browser's permission prompt
    // `raw`: no speech processing (for recording an animal)
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: !o.raw, autoGainControl: !o.raw, channelCount: 1 } });
    await this.start();
    const ctx = this.ctx!;
    const src = ctx.createMediaStreamSource(stream);
    const rec = new AudioWorkletNode(ctx, "pet-recorder", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit" });
    rec.port.onmessage = (e: MessageEvent<FromRecorder>) => onPcm(e.data.data);
    src.connect(rec);
    return {
      sampleRate: ctx.sampleRate,
      stop: () => {
        src.disconnect();
        rec.port.onmessage = null;
        stream.getTracks().forEach((t) => t.stop());
      },
    };
  }

  /** Play a decoded buffer (the person's own voice) through the speakers and the recording tap. */
  playBuffer(buf: AudioBuffer, when = 0): AudioBufferSourceNode | null {
    if (!this.ctx) return null;
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.connect(this.ctx.destination);
    if (this.tap) s.connect(this.tap);
    s.start(this.ctx.currentTime + when);
    return s;
  }
}
