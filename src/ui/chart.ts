/**
 * The pitch comparison: the person's contour and the pet's, each in semitones around its own
 * median, on one time axis. Same shape = same tune. The dot is the pitch the engine reports
 * while it plays.
 */
import type { Prosody } from "../analysis/prosody.ts";
import { NEON, type Rect } from "./cutaway.ts";

export interface ChartData {
  prosody: Prosody | null;
  /** pet pitch per prosody frame, Hz (0 in pauses) */
  pet: Float32Array | null;
  petMedian: number;
  /** live frames while recording (raw YIN, Hz or 0) */
  live?: { f0: number[]; hop: number };
  /** seconds into the call, or −1 */
  playhead: number;
  /** pitch the engine reports now, Hz */
  engineF0: number;
  humanLabel: string;
  petLabel: string;
}

const RANGE = 16; // ± semitones shown

export function drawChart(g: CanvasRenderingContext2D, r: Rect, d: ChartData, fontPx = 11): void {
  g.save();
  g.fillStyle = "#1d1228";
  g.fillRect(r.x, r.y, r.w, r.h);
  const pad = { l: 34, r: 10, t: 20, b: 18 };
  const x0 = r.x + pad.l;
  const x1 = r.x + r.w - pad.r;
  const y0 = r.y + pad.t;
  const y1 = r.y + r.h - pad.b;
  const mid = (y0 + y1) / 2;
  g.font = `${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  g.textBaseline = "middle";
  // grid: octaves
  for (const st of [-12, 0, 12]) {
    const y = mid - (st / RANGE) * ((y1 - y0) / 2);
    g.strokeStyle = st === 0 ? "rgba(201,179,208,0.45)" : "rgba(201,179,208,0.18)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x0, y);
    g.lineTo(x1, y);
    g.stroke();
    g.fillStyle = "rgba(201,179,208,0.8)";
    g.textAlign = "right";
    g.fillText(st === 0 ? "中位" : (st > 0 ? "+" : "−") + "8度", x0 - 4, y);
  }
  g.textAlign = "left";
  g.fillStyle = NEON.line;
  g.fillText("— " + d.humanLabel, x0, r.y + 10);
  g.fillStyle = NEON.hot;
  g.textAlign = "right";
  g.fillText(d.petLabel + " —", x1, r.y + 10);

  const Y = (hz: number, med: number) => mid - (Math.max(-RANGE, Math.min(RANGE, 12 * Math.log2(hz / med))) / RANGE) * ((y1 - y0) / 2);
  const curve = (f0: ArrayLike<number>, n: number, total: number, med: number, color: string, width: number) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineJoin = "round";
    g.lineCap = "round";
    let pen = false;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      if (!(f0[i] > 0)) {
        pen = false;
        continue;
      }
      const x = x0 + ((i + 0.5) / total) * (x1 - x0);
      const y = Y(f0[i], med);
      if (pen) g.lineTo(x, y);
      else g.moveTo(x, y);
      pen = true;
    }
    g.stroke();
  };

  const p = d.prosody;
  if (p && p.f0.length) {
    const n = p.f0.length;
    // loudness as a faint band, syllable starts as ticks
    g.fillStyle = "rgba(127,227,196,0.1)";
    g.beginPath();
    g.moveTo(x0, y1);
    for (let i = 0; i < n; i++) g.lineTo(x0 + ((i + 0.5) / n) * (x1 - x0), y1 - p.energy[i] * (y1 - y0) * 0.35);
    g.lineTo(x1, y1);
    g.fill();
    g.strokeStyle = "rgba(255,210,122,0.55)";
    for (const s of p.syllables) {
      const x = x0 + (s.t0 / (n * p.hop)) * (x1 - x0);
      g.beginPath();
      g.moveTo(x, y1);
      g.lineTo(x, y1 - 6);
      g.stroke();
    }
    if (p.medianF0 > 0) curve(p.f0, n, n, p.medianF0, NEON.line, 2);
    if (d.pet && d.petMedian > 0) curve(d.pet, n, n, d.petMedian, NEON.hot, 2.4);
    if (d.playhead >= 0) {
      const x = x0 + Math.min(1, d.playhead / (n * p.hop)) * (x1 - x0);
      g.strokeStyle = "rgba(255,255,255,0.6)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, y0);
      g.lineTo(x, y1);
      g.stroke();
      if (d.engineF0 > 0 && d.petMedian > 0) {
        g.fillStyle = "#fff";
        g.beginPath();
        g.arc(x, Y(d.engineF0, d.petMedian), 4, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.fillStyle = "rgba(201,179,208,0.8)";
    g.textAlign = "right";
    g.fillText((n * p.hop).toFixed(1) + " s", x1, y1 + 9);
  } else if (d.live && d.live.f0.length) {
    // while recording: raw pitch scrolling in, around 200 Hz
    const total = Math.max(300, d.live.f0.length);
    const voiced = d.live.f0.filter((v) => v > 0).sort((a, b) => a - b);
    curve(d.live.f0, d.live.f0.length, total, voiced[voiced.length >> 1] || 200, NEON.line, 2);
  } else {
    g.fillStyle = "rgba(201,179,208,0.7)";
    g.textAlign = "center";
    g.fillText("录一句话，这里会画出你和它的音高曲线", (x0 + x1) / 2, mid - 14);
  }
  g.restore();
}
