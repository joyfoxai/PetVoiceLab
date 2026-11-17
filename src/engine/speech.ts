/**
 * Typed facade over the speech wasm (speech/, CHIMERA's human voice): English text → 48 kHz mono.
 * Runs in a Worker (and in Node for tests); never on the main thread.
 */
type Fn = (...a: number[]) => number;
type Exports = { memory: WebAssembly.Memory } & Record<string, Fn>;

export const SPEECH_RATE = 48000;
export type SpeakerBody = "male" | "female" | "child";
const BODY: Record<SpeakerBody, number> = { male: 0, female: 1, child: 2 };

export class Speech {
  private readonly x: Exports;
  dictLoaded = false;

  constructor(module: WebAssembly.Module) {
    this.x = new WebAssembly.Instance(module, {}).exports as unknown as Exports;
  }

  private withBytes<T>(bytes: Uint8Array, f: (ptr: number, n: number) => T): T {
    const n = bytes.length;
    const ptr = this.x.sp_alloc(n);
    new Uint8Array(this.x.memory.buffer, ptr, n).set(bytes);
    try {
      return f(ptr, n);
    } finally {
      this.x.sp_free(ptr, n);
    }
  }

  /** The CMU Pronouncing Dictionary as UTF-8 text. Without it words are spelled out by rule. */
  loadDict(utf8: Uint8Array): boolean {
    this.dictLoaded = this.withBytes(utf8, (p, n) => this.x.sp_load_dict(p, n)) === 1;
    return this.dictLoaded;
  }

  /** Speak. Returns an empty array when nothing in the text is pronounceable. */
  say(text: string, body: SpeakerBody = "female", rate = 1): Float32Array {
    const bytes = new TextEncoder().encode(text.slice(0, 400));
    if (!bytes.length) return new Float32Array(0);
    const n = this.withBytes(bytes, (p, len) => this.x.sp_say(p, len, BODY[body], rate));
    return new Float32Array(this.x.memory.buffer, this.x.sp_out_ptr(), n).slice();
  }
}
