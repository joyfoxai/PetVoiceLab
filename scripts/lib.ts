/** Node-side helpers for the scripts: wasm module, WAV in/out, a small spectrogram PNG. */
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { spectrogram } from "../src/analysis/fft.ts";
export { spectrogram };

export function loadModule(): WebAssembly.Module {
  return new WebAssembly.Module(readFileSync(new URL("../src/engine/petvoice.wasm", import.meta.url)));
}

export function writeWav(path: string, x: Float32Array, fs: number): void {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + x.length * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(fs, 24);
  b.writeUInt32LE(fs * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  writeFileSync(path, b);
}

export function readWav(path: string): { x: Float32Array; fs: number } {
  const b = readFileSync(path);
  let o = 12;
  let fs = 48000;
  let ch = 1;
  let bits = 16;
  let fmt = 1;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4);
    const n = b.readUInt32LE(o + 4);
    if (id === "fmt ") {
      fmt = b.readUInt16LE(o + 8);
      ch = b.readUInt16LE(o + 10);
      fs = b.readUInt32LE(o + 12);
      bits = b.readUInt16LE(o + 22);
    } else if (id === "data") {
      const frames = Math.floor(Math.min(n, b.length - o - 8) / (ch * (bits / 8)));
      const x = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const p = o + 8 + i * ch * (bits / 8);
        x[i] = fmt === 3 ? b.readFloatLE(p) : bits === 16 ? b.readInt16LE(p) / 32768 : b.readInt32LE(p) / 2147483648;
      }
      return { x, fs };
    }
    o += 8 + n + (n & 1);
  }
  throw new Error("no data chunk in " + path);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

export function writePng(path: string, w: number, h: number, rgb: Uint8Array): void {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

/** Several signals' spectrograms side by side (0..maxHz), for looking at what was rendered. */
export function writeSpectrogramSheet(path: string, items: { x: Float32Array }[], fs: number, maxHz = 12000): void {
  const n = 1024;
  const hop = 240;
  const bins = Math.floor((maxHz / (fs / 2)) * (n / 2));
  const H = 256;
  const specs = items.map((it) => spectrogram(it.x, n, hop));
  const gap = 6;
  const W = specs.reduce((a, s) => a + s.length + gap, 0);
  const rgb = new Uint8Array(W * H * 3);
  let x0 = 0;
  for (const s of specs) {
    let peak = -200;
    for (const r of s) for (let i = 0; i < bins; i++) peak = Math.max(peak, r[i]);
    s.forEach((r, xi) => {
      for (let y = 0; y < H; y++) {
        const bin = Math.floor(((H - 1 - y) / H) * bins);
        const v = Math.max(0, Math.min(1, (r[bin] - (peak - 70)) / 70));
        const p = (y * W + x0 + xi) * 3;
        rgb[p] = Math.round(255 * Math.min(1, v * 1.6));
        rgb[p + 1] = Math.round(255 * v * v);
        rgb[p + 2] = Math.round(255 * Math.max(0, 0.35 - Math.abs(v - 0.35)) * 2);
      }
    });
    x0 += s.length;
    for (let y = 0; y < H; y++) for (let g = 0; g < gap; g++) rgb[(y * W + x0 + g) * 3 + 2] = 90;
    x0 += gap;
  }
  writePng(path, W, H, rgb);
}

export function stats(x: Float32Array): { peak: number; rms: number } {
  let peak = 0;
  let acc = 0;
  for (const v of x) {
    peak = Math.max(peak, Math.abs(v));
    acc += v * v;
  }
  return { peak, rms: Math.sqrt(acc / Math.max(1, x.length)) };
}

export function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
}

export { combPitch } from "../src/analysis/comb.ts";
