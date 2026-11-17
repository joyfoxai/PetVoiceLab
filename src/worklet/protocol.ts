/** Messages between the main thread and the AudioWorklet. */
export type ToWorklet =
  | { type: "body"; body: Float64Array }
  | { type: "live"; frame: Float64Array; gate: number }
  | { type: "play"; keys: Float64Array; loop: boolean; level: number; id: number }
  | { type: "level"; level: number }
  | { type: "economy"; on: boolean }
  | { type: "stop" };

export type FromWorklet =
  /** telemetry block (see params/protocol.ts) stamped with the audio clock of the block it describes */
  | { type: "tele"; time: number; data: Float32Array; load: number }
  /** first audible sample of play `id` left the engine at audio time `time` */
  | { type: "onset"; id: number; time: number }
  | { type: "ended"; id: number; time: number }
  | { type: "error"; message: string };

/** microphone capture processor → main */
export type FromRecorder = { type: "pcm"; data: Float32Array };
