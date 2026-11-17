/**
 * The voiceprint card: name, the sliders, what they became in centimetres and hertz, a
 * spectrogram and waveform of the pet's signature call, and a cutaway drawn from the engine's
 * own state at the call's loudest moment.
 */
import { spectrogram } from "../analysis/fft.ts";
import { firstFormant, type PetSpec, type VoiceCharacter } from "../params/pet.ts";
import { decodeTelemetry, type VoiceBody } from "../params/protocol.ts";
import { CutawayFx, drawCutaway, NEON, type Coat } from "./cutaway.ts";

export const MOOD_ZH = { coax: "撒娇", happy: "开心", curious: "好奇", excited: "兴奋", sad: "委屈", scared: "害怕", sleepy: "困倦", angry: "生气" } as const;
const FONT = '-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif';
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export interface CardData {
  spec: PetSpec;
  body: VoiceBody;
  character: VoiceCharacter;
  callName: string;
  samples: Float32Array;
  sampleRate: number;
  snapshot: Float32Array;
  url: string;
  maxTract: number;
  coat?: Coat;
}

export function ageWords(spec: PetSpec): string {
  const a = spec.age;
  const cub = spec.species === "cat" ? "奶猫" : "奶狗";
  return a < 0.15 ? cub : a < 0.35 ? "少年" : a < 0.65 ? "成年" : a < 0.85 ? "中老年" : "年迈";
}

export function drawCard(c: HTMLCanvasElement, d: CardData): void {
  const g = c.getContext("2d")!;
  const W = c.width;
  const H = c.height;
  g.fillStyle = NEON.bg;
  g.fillRect(0, 0, W, H);
  const grad = g.createRadialGradient(W * 0.6, H * 0.3, 50, W * 0.6, H * 0.3, W * 0.9);
  grad.addColorStop(0, "#3a2247");
  grad.addColorStop(1, NEON.bg);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = NEON.line;
  g.lineWidth = 3;
  g.globalAlpha = 0.8;
  roundRect(g, 24, 24, W - 48, H - 48, 36);
  g.stroke();
  g.globalAlpha = 1;

  // header
  g.textBaseline = "alphabetic";
  g.textAlign = "left";
  g.font = `28px ${MONO}`;
  g.fillStyle = NEON.mute;
  g.fillText("PETVOICE LAB · 声纹卡片", 64, 96);
  g.font = `700 92px ${FONT}`;
  g.fillStyle = NEON.lime;
  g.shadowColor = NEON.lime;
  g.shadowBlur = 24;
  g.fillText(d.spec.name || "无名", 64, 204);
  g.shadowBlur = 0;
  g.font = `34px ${FONT}`;
  g.fillStyle = NEON.text;
  g.fillText(`${d.spec.species === "cat" ? "猫" : "狗"} · ${ageWords(d.spec)} · ${MOOD_ZH[d.spec.mood]}`, 68, 262);

  // cutaway from the engine snapshot
  if (d.snapshot.length) {
    // drawn mid-call: the fur lets the airway show through, as it does on the page while it sounds
    const fx = new CutawayFx();
    fx.level = 0.85;
    // (the portrait fills its frame whatever the pet's size; the numbers below say how big it is)
    drawCutaway(g, { x: 40, y: 250, w: W - 80, h: 590 }, decodeTelemetry(d.snapshot), d.body, d.spec, fx, { time: 0, weight: 1.1, maxTract: d.character.tractLen, coat: d.coat, xray: 0 });
  }

  // derived numbers
  const tract = d.character.tractLen;
  const stats: [string, string][] = [
    ["声道长度", `${tract.toFixed(1)} cm`],
    ["基频", `${Math.round(d.character.f0)} Hz`],
    ["第一共振峰≈", `${Math.round(firstFormant(tract))} Hz`],
    ["肺压", `${d.character.pressure.toFixed(1)} cmH₂O`],
  ];
  const colW = (W - 128) / stats.length;
  stats.forEach(([k, v], i) => {
    const x = 64 + i * colW;
    g.font = `26px ${FONT}`;
    g.fillStyle = NEON.mute;
    g.fillText(k, x, 850);
    g.font = `600 40px ${MONO}`;
    g.fillStyle = NEON.line;
    g.fillText(v, x, 900);
  });

  // slider bars
  const bars: [string, number][] = [
    ["个头", d.spec.size],
    ["年纪", d.spec.age],
    ["口鼻", d.spec.snout],
    ["嗓音", (d.spec.texture + 1) / 2],
  ];
  bars.forEach(([k, v], i) => {
    const x = 64 + (i % 2) * ((W - 128) / 2 + 0);
    const y = 944 + Math.floor(i / 2) * 50;
    const bw = (W - 128) / 2 - 130;
    g.font = `28px ${FONT}`;
    g.fillStyle = NEON.text;
    g.fillText(k, x, y + 10);
    g.fillStyle = "#3d2a50";
    roundRect(g, x + 76, y - 10, bw, 16, 8);
    g.fill();
    g.fillStyle = NEON.hot;
    roundRect(g, x + 76, y - 10, Math.max(16, bw * v), 16, 8);
    g.fill();
  });

  // spectrogram + waveform of the signature call
  const sx = 64;
  const sy = 1066;
  const sw = W - 128;
  const sh = 170;
  g.font = `26px ${FONT}`;
  g.fillStyle = NEON.mute;
  g.fillText(`「${d.callName}」的频谱（0–8 kHz）与波形 · ${(d.samples.length / d.sampleRate).toFixed(1)} s`, sx, sy - 14);
  drawSpectrogram(g, d.samples, d.sampleRate, sx, sy, sw, sh, 8000);
  drawWave(g, d.samples, sx, sy + sh + 8, sw, 60);

  g.font = `22px ${MONO}`;
  g.fillStyle = NEON.mute;
  const url = d.url.length > 78 ? d.url.slice(0, 75) + "…" : d.url;
  g.fillText(url, 64, H - 92);
  g.fillText("物理建模声道合成（CHIMERA 引擎）· 非录音 · 非神经网络", 64, H - 58);
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export function drawSpectrogram(g: CanvasRenderingContext2D, x: Float32Array, fs: number, px: number, py: number, w: number, h: number, maxHz: number): void {
  const n = 1024;
  const hop = Math.max(64, Math.floor((x.length - n) / 360));
  const spec = spectrogram(x, n, hop);
  if (!spec.length) return;
  const bins = Math.floor((maxHz / (fs / 2)) * (n / 2));
  let peak = -200;
  for (const r of spec) for (let i = 0; i < bins; i++) peak = Math.max(peak, r[i]);
  const cols = spec.length;
  const rows = 96;
  const img = g.createImageData(cols, rows);
  for (let cx = 0; cx < cols; cx++) {
    for (let y = 0; y < rows; y++) {
      const bin = Math.floor(((rows - 1 - y) / rows) * bins);
      const v = Math.max(0, Math.min(1, (spec[cx][bin] - (peak - 62)) / 62));
      const p = (y * cols + cx) * 4;
      // plum → coral → butter → cream
      img.data[p] = 29 + 226 * Math.min(1, v * 1.5);
      img.data[p + 1] = 18 + 237 * Math.min(1, Math.max(0, v * 1.35 - 0.22));
      img.data[p + 2] = 40 + 60 * Math.min(1, v * 2) * (1 - v) + 190 * Math.max(0, v - 0.8) * 5 * 0.2;
      img.data[p + 3] = 255;
    }
  }
  const off = document.createElement("canvas");
  off.width = cols;
  off.height = rows;
  off.getContext("2d")!.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(off, px, py, w, h);
  g.strokeStyle = "#3d2a50";
  g.lineWidth = 2;
  g.strokeRect(px, py, w, h);
}

export function drawWave(g: CanvasRenderingContext2D, x: Float32Array, px: number, py: number, w: number, h: number): void {
  g.strokeStyle = NEON.line;
  g.lineWidth = 1.5;
  g.beginPath();
  const step = x.length / w;
  for (let i = 0; i < w; i++) {
    let lo = 0;
    let hi = 0;
    const a = Math.floor(i * step);
    const b = Math.min(x.length, Math.floor((i + 1) * step) + 1);
    for (let j = a; j < b; j++) {
      if (x[j] < lo) lo = x[j];
      if (x[j] > hi) hi = x[j];
    }
    g.moveTo(px + i, py + h / 2 - hi * h * 0.5);
    g.lineTo(px + i, py + h / 2 - lo * h * 0.5 + 1);
  }
  g.stroke();
}
