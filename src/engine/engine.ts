/**
 * Typed facade over the wasm sounding layer. No DOM or Web Audio in here: the same class runs in
 * the AudioWorklet (live sound), in a Worker (offline renders for cards) and in Node (tests).
 */
import { KEY_SIZE, N_BODY, N_FRAME, packBody, packFrame, packTrack, type VoiceBody, type VoiceFrame, type VoiceTrack } from "../params/protocol.ts";

type Fn = (...a: number[]) => number;
type Exports = { memory: WebAssembly.Memory } & Record<string, Fn>;

export const MAX_RENDER = 4096;

export class PetEngine {
  private readonly x: Exports;
  private readonly h: number;
  readonly sampleRate: number;

  constructor(module: WebAssembly.Module, sampleRate: number) {
    this.x = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
    if (this.x.pv_n_body() !== N_BODY || this.x.pv_n_frame() !== N_FRAME || this.x.pv_key_size() !== KEY_SIZE) {
      throw new Error("engine and protocol.ts disagree on the parameter layout");
    }
    this.sampleRate = sampleRate;
    this.h = this.x.pv_new(sampleRate);
  }

  private f64(ptr: number, n: number): Float64Array {
    return new Float64Array(this.x.memory.buffer, ptr, n);
  }

  setBody(b: VoiceBody): void {
    packBody(b, this.f64(this.x.pv_body_ptr(this.h), N_BODY));
    this.x.pv_apply_body(this.h);
  }

  setBodyPacked(b: Float64Array): void {
    this.f64(this.x.pv_body_ptr(this.h), N_BODY).set(b);
    this.x.pv_apply_body(this.h);
  }

  /** Hold this frame; `gate` 0..1 is the breath gate (0: silent, the mouth still moves). */
  setLive(f: VoiceFrame, gate: number): void {
    packFrame(f, this.f64(this.x.pv_frame_ptr(this.h), N_FRAME));
    this.x.pv_set_live(this.h, gate);
  }

  setLivePacked(f: Float64Array, gate: number): void {
    this.f64(this.x.pv_frame_ptr(this.h), N_FRAME).set(f);
    this.x.pv_set_live(this.h, gate);
  }

  /** Play a track at `volume` × its own microphone gain. */
  play(track: VoiceTrack, loop = false, volume = 1): void {
    this.setLevel(volume * (track.mic ?? 1));
    this.playPacked(packTrack(track), loop);
  }

  playPacked(keys: Float64Array, loop = false): void {
    const n = Math.floor(keys.length / KEY_SIZE);
    const ptr = this.x.pv_track_ptr(this.h, n);
    this.f64(ptr, n * KEY_SIZE).set(keys.subarray(0, n * KEY_SIZE));
    this.x.pv_play_track(this.h, n, loop ? 1 : 0);
  }

  stop(): void {
    this.x.pv_stop_track(this.h);
  }

  setLevel(level: number): void {
    this.x.pv_set_level(this.h, level);
  }

  /** Halve the internal rate for short tracts (for devices that cannot keep up). */
  setEconomy(on: boolean): void {
    this.x.pv_set_economy(this.h, on ? 1 : 0);
  }

  /** Render into `out` (mono). */
  render(out: Float32Array): void {
    let done = 0;
    while (done < out.length) {
      const n = Math.min(MAX_RENDER, out.length - done);
      const ptr = this.x.pv_render(this.h, n);
      out.set(new Float32Array(this.x.memory.buffer, ptr, n), done);
      done += n;
    }
  }

  /** A view of the telemetry block, valid until the next engine call. */
  telemetry(): Float32Array {
    const n = this.x.pv_telemetry(this.h);
    return new Float32Array(this.x.memory.buffer, this.x.pv_tele_ptr(this.h), n);
  }

  free(): void {
    this.x.pv_free(this.h);
  }
}

/** Render a track offline: the body, then the track, plus a tail for the tract to ring out. */
export function renderOffline(module: WebAssembly.Module, body: VoiceBody, track: VoiceTrack, sampleRate = 48000, tail = 0.25): Float32Array {
  const e = new PetEngine(module, sampleRate);
  e.setBody(body);
  // one control period for the body to swap in
  e.render(new Float32Array(256));
  e.play(track);
  const out = new Float32Array(Math.ceil((track.duration + tail) * sampleRate));
  e.render(out);
  e.free();
  return out;
}
