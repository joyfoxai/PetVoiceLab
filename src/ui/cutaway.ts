/**
 * The neon wireframe head, in three dimensions. Every moving line is read from the engine's
 * telemetry:
 *  - the airway is a tube of rings, one per engine section, sized from that section's current
 *    area (the palate and the back of the throat are rigid, so a wider section pushes the
 *    tongue/jaw side out: the jaw opens because the engine's lip sections opened, not because a
 *    clip plays). The throat is drawn round; the mouth wide and flat (height = area / width);
 *  - tube lengths (larynx lowering, lip protrusion) are the engine's current lengths;
 *  - the two vocal folds part sideways by the engine's mean glottal area; the velum flap swings
 *    by its port area;
 *  - each ring glows with that section's acoustic pressure; the drifting dots follow the signed
 *    airflow through the glottis (they run backwards on the in-breath of a purr);
 *  - the rings leaving the mouth scale with the output level.
 * The engine is one-dimensional (areas along a line). The third dimension is a drawing choice:
 * widths across the head are not simulated. The skull cage, ears, eyes and whiskers are
 * decoration, placed from the body's static lengths; the lower jaw's cage hangs from the
 * engine's own mouth floor.
 */
import type { PetSpec } from "../params/pet.ts";
import type { Telemetry, VoiceBody } from "../params/protocol.ts";
import { drawSkin, type SkinCoat } from "./skin.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Default three-quarter view: the head turned a little toward the viewer, seen from just above. */
export const DEFAULT_VIEW = { yaw: -0.55, pitch: 0.16 };

/** Per-canvas state: the camera, and the animation's dots and rings. */
export class CutawayFx {
  dots: { s: number; off: number; side: number }[] = [];
  rings: { r: number; a: number }[] = [];
  lastRing = 0;
  lastT = 0;
  /** smoothed level, for decoration */
  level = 0;
  /** camera angles, radians: yaw turns the head about its vertical axis, pitch tips it */
  view = { ...DEFAULT_VIEW };
  /** where things landed on screen at the last draw, for pointer hit tests (canvas px) */
  hit = { nose: [0, 0] as [number, number], unit: 0 };
  /** words popping out over its head: { text, born (seconds) } */
  bubbles: { text: string; born: number }[] = [];
  constructor() {
    for (let i = 0; i < 54; i++) this.dots.push({ s: Math.random(), off: Math.random() * 2 - 1, side: Math.random() * 2 - 1 });
  }
}

/** The page's colours (a warm dark: plum ground, cream text, coral / mint / butter accents). */
export const NEON = {
  bg: "#170f20",
  line: "#7fe3c4",
  hot: "#ff8a73",
  soft: "#c7b3ff",
  lime: "#ffd27a",
  amber: "#ffd27a",
  dim: "rgba(210,180,230,0.3)",
  text: "#fff3e4",
  mute: "#bfa8c6",
};

/** A coat for the pet's outside: fur, the lighter muzzle and chest, the outline, ear and tongue pink, nose, eye. */
export type Coat = SkinCoat;
export const COATS = {
  orange: { fur: "#e39a52", light: "#fff3e2", dark: "#a85a2a", pink: "#f2a79b", nose: "#d9776f", eye: "#3a2233", iris: "#c9a93a", pattern: "tabby" },
  cream: { fur: "#f1d9b4", light: "#fffaf0", dark: "#c49a6a", pink: "#f7b9ae", nose: "#e89088", eye: "#3a2233", iris: "#6fa7cf", pattern: "bicolor" },
  black: { fur: "#3d3646", light: "#6c6478", dark: "#17131d", pink: "#b98590", nose: "#2a2330", eye: "#ffd27a", iris: "#e0b53a", pattern: "solid" },
  grey: { fur: "#9a96a8", light: "#eeeaf3", dark: "#55506a", pink: "#e8a9b5", nose: "#c98090", eye: "#3a2233", iris: "#d88a2e", pattern: "tabby" },
  white: { fur: "#f3ece2", light: "#ffffff", dark: "#bfae9c", pink: "#f7b9ae", nose: "#3d2f36", eye: "#3a2233", iris: "#5a3a22", pattern: "solid", ears: "erect" },
  shiba: { fur: "#d98f48", light: "#fff4e3", dark: "#96552a", pink: "#f2a79b", nose: "#2b2026", eye: "#3a2233", iris: "#5a3520", pattern: "urajiro", ears: "erect" },
  brown: { fur: "#8a5a3a", light: "#cfa57c", dark: "#4a2c1b", pink: "#e39b90", nose: "#241920", eye: "#2a1a22", iris: "#5c3a1e", pattern: "solid", ears: "drop" },
  tan: { fur: "#d19c62", light: "#fdebd0", dark: "#8e5a34", pink: "#f2a79b", nose: "#33262c", eye: "#3a2233", iris: "#4e3220", pattern: "urajiro", ears: "drop" },
} satisfies Record<string, Coat>;
export type CoatId = keyof typeof COATS;


type P = [number, number];
type V = [number, number, number];
const add = (a: P, b: P, k = 1): P => [a[0] + b[0] * k, a[1] + b[1] * k];
const dir = (deg: number): P => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
const nrm = (d: P): P => [-d[1], d[0]];
const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const sstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const v3 = (p: P, z = 0): V => [p[0], p[1], z];

interface Layout {
  /** per section glottis→lips: rigid (dorsal) wall point, moving (ventral) wall point, tangent angle, half-width across */
  upper: P[];
  lower: P[];
  ang: number[];
  half: number[];
  nPh: number;
  /** rigid frame (cm, y up) */
  lipRest: P;
  fwd: P;
  up: P;
  S: number;
  M: number;
}

const TH_GLOTTIS = 62;
const TH_JUNCTION = 22;
const TH_ORAL = -5;

/** Section walls in cm (y up) in the head's mid plane, pharynx–mouth junction at the origin. */
function layout(t: Telemetry, body: VoiceBody): Layout {
  const nPh = t.pharynx.length;
  const nOr = t.oral.length;
  const n = nPh + nOr;
  const upper: P[] = new Array(n);
  const lower: P[] = new Array(n);
  const ang: number[] = new Array(n);
  const half: number[] = new Array(n);
  const rPh = Math.sqrt(body.pharynxArea / Math.PI) * 0.9;
  const rOr = Math.sqrt(body.oralArea / Math.PI) * 0.8;
  // Area → the height drawn. The throat is a round tube (height = diameter). The mouth is wide
  // and flat, so there the height is area / width with a constant width: an opening jaw then
  // reads as an opening jaw. `flat` blends the two laws.
  const mouthWidth = 1.3 * Math.sqrt(body.oralArea);
  const place = (k: number, mid: P, th: number, r0: number, area: number, flat: number) => {
    const nn = nrm(dir(th));
    const a = Math.max(0, area);
    const round = 2 * Math.sqrt(a / Math.PI);
    const dia = lerp(round, a / mouthWidth, flat);
    upper[k] = add(mid, nn, r0);
    lower[k] = add(upper[k], nn, -dia);
    ang[k] = th;
    half[k] = lerp(round, mouthWidth, flat) / 2;
  };
  // pharynx: walk back from the junction
  const dPh = t.lenPh / Math.max(1, nPh);
  let c: P = [0, 0];
  for (let i = nPh - 1; i >= 0; i--) {
    const s = (nPh - 1 - i + 0.5) * dPh;
    const th = TH_JUNCTION + (TH_GLOTTIS - TH_JUNCTION) * sstep(0, t.lenPh, s);
    const d = dir(th);
    const mid = add(c, d, -dPh / 2);
    c = add(c, d, -dPh);
    place(i, mid, th, lerp(rOr, rPh, sstep(0, t.lenPh * 0.5, s)), t.pharynx[i], 1 - sstep(0, t.lenPh * 0.6, s));
  }
  // mouth: walk forward
  const dOr = t.lenOr / Math.max(1, nOr);
  const bend = body.oralLen * 0.4;
  c = [0, 0];
  for (let i = 0; i < nOr; i++) {
    const s = (i + 0.5) * dOr;
    const th = TH_ORAL + (TH_JUNCTION - TH_ORAL) * (1 - sstep(0, bend, s));
    const d = dir(th);
    const mid = add(c, d, dOr / 2);
    c = add(c, d, dOr);
    place(nPh + i, mid, th, rOr, t.oral[i], 1);
  }
  // rigid frame from the body's rest lengths (so protruding lips move, the skull does not)
  let lip: P = [0, 0];
  const steps = 24;
  for (let i = 0; i < steps; i++) {
    const s = ((i + 0.5) / steps) * body.oralLen;
    lip = add(lip, dir(TH_ORAL + (TH_JUNCTION - TH_ORAL) * (1 - sstep(0, bend, s))), body.oralLen / steps);
  }
  const fwd = dir(TH_ORAL);
  const up = nrm(fwd);
  const tract = body.pharynxLen + body.oralLen;
  return { upper, lower, ang, half, nPh, lipRest: add(lip, up, rOr), fwd, up, S: tract * 0.5, M: body.oralLen * 0.62 };
}

function energyColor(e: number, alpha: number): string {
  // mint → butter → coral → near white
  const r = Math.round(lerp(127, 255, clamp(e * 1.6)));
  const g = Math.round(lerp(227, 150, clamp(e * 1.3 - 0.3)) + 80 * clamp(e - 0.8) * 5 * 0.2);
  const b = Math.round(lerp(196, 120, clamp(e * 1.5)) + 100 * clamp(e - 0.8) * 5 * 0.2);
  return `rgba(${r},${Math.min(255, g)},${Math.min(255, b)},${alpha})`;
}

/** Pressure RMS (dyn/cm²) → 0..1 for drawing. */
function energy(rms: number): number {
  return clamp((Math.log10(1 + rms) - 1.2) / 3.3);
}

export interface CutawayOptions {
  /** seconds, for decoration timing */
  time: number;
  /** show labels (off on small export frames) */
  labels?: boolean;
  /** stroke scale */
  weight?: number;
  /** largest tract of the species, cm: smaller pets are drawn smaller */
  maxTract: number;
  /** a slow idle sway of the camera, radians of yaw (0: still) */
  sway?: number;
  /** draw the pet's outside in this coat; without it only the wireframe is drawn */
  coat?: Coat;
  /** with a coat: 0 = the outside (the airway shows through only while it sounds) … 1 = see-through, full wireframe */
  xray?: number;
  /** mark the nose as draggable */
  handles?: boolean;
}

export function drawCutaway(g: CanvasRenderingContext2D, rect: Rect, t: Telemetry, body: VoiceBody, spec: PetSpec, fx: CutawayFx, o: CutawayOptions): void {
  if (!t.pharynx.length || !t.oral.length) return;
  const L = layout(t, body);
  const { fwd, up, S, lipRest } = L;
  const cat = spec.species === "cat";
  // How far the muzzle stands out in front of the skull. Most of the mouth lies under the
  // skull (a cat's almost all of it), so this is a part of the oral tube, not the whole of it.
  const M = L.M * (cat ? 0.55 : 0.72);
  const dt = clamp(o.time - fx.lastT, 0, 0.1);
  fx.lastT = o.time;
  fx.level += (clamp(t.outRms * 5) - fx.level) * clamp(dt * 14);

  // ---- rigid landmarks in the mid plane (cm) ----
  const at = (f: number, u: number): P => add(add(lipRest, fwd, f), up, u);
  const noseTip = at(0.05 * S, cat ? 0.2 * S : 0.24 * S);
  const stop = at(-M, cat ? 0.62 * S : 0.5 * S);
  const brow = at(-M - 0.22 * S, cat ? 0.98 * S : 0.86 * S);
  const crown = at(-M - 0.72 * S, cat ? 1.1 * S : 1.0 * S);
  const occiput = at(-M - 1.38 * S, 0.62 * S);
  const nAll = L.upper.length;
  const glottisUp = L.upper[0];
  const glottisLo = L.lower[0];
  const thG = L.ang[0];
  const back = dir(thG + 180);
  const nG = nrm(dir(thG));
  const rTr = Math.sqrt(body.tracheaArea / Math.PI);
  const neckLen = Math.min(body.tracheaLen, S * 1.0);
  const gMid: P = [(glottisUp[0] + glottisLo[0]) / 2, (glottisUp[1] + glottisLo[1]) / 2];
  const gRest = add(L.upper[0], nG, -Math.sqrt(body.pharynxArea / Math.PI) * 0.9);
  // trachea runs down and back from the larynx, curving toward the chest
  const trachea: { c: P; n: P }[] = [];
  {
    let c = gRest;
    const n = 10;
    for (let i = 0; i <= n; i++) {
      const th = thG + 180 + 28 * (i / n);
      trachea.push({ c, n: nrm(dir(th)) });
      c = add(c, dir(th), neckLen / n);
    }
  }
  const tEnd = trachea[trachea.length - 1].c;
  const nEnd = nrm(dir(thG + 28));
  const napeEnd = add(tEnd, nEnd, S * 1.05);
  const throatEnd = add(tEnd, nEnd, -S * 0.6);
  // half-widths across the head (decoration; nothing lateral is simulated)
  const wSkull = S * (cat ? 0.6 : 0.5);
  const wStop = S * (cat ? 0.42 : 0.36);
  const wLip = S * (cat ? 0.2 : 0.17);
  const wNeck = S * 0.46;

  // ---- camera: fit the rigid head, smaller pets smaller; rotate about its middle ----
  const pts = [noseTip, stop, brow, crown, occiput, napeEnd, throatEnd, at(0.1 * S, -0.75 * S), at(-M - 0.9 * S, (cat ? 1.65 : 1.2) * S)];
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const tract = body.pharynxLen + body.oralLen;
  const rel = Math.pow(clamp(tract / o.maxTract, 0.2, 1), 0.45);
  const k = Math.min((rect.w * 0.7) / (maxX - minX), (rect.h * 0.78) / (maxY - minY)) * rel;
  const px = (minX + maxX) / 2;
  const py = (minY + maxY) / 2;
  const ox = rect.x + rect.w * 0.46;
  const oy = rect.y + rect.h * 0.5;
  const yaw = fx.view.yaw + (o.sway ?? 0) * Math.sin(o.time * 0.45);
  const pitch = fx.view.pitch;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const eye = (maxX - minX) * 3.2; // camera distance, cm
  /** model (cm) → [screen x, screen y, depth toward the viewer in cm] */
  const X = (p: V): V => {
    const x = p[0] - px;
    const y = p[1] - py;
    const z = p[2];
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const y2 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    const f = eye / (eye - z2);
    return [ox + x1 * k * f, oy - y2 * k * f, z2];
  };
  const W = (o.weight ?? 1) * clamp(Math.min(rect.w, rect.h * 1.3) / 520, 0.7, 2.2);
  const depthSpan = S * 0.9;
  /** 0 (far side) … 1 (near side) for a depth in cm */
  const near = (z: number) => clamp(0.5 + z / (2 * depthSpan));

  /** trace a 3D polyline; returns its mean nearness 0..1 */
  const path = (ps: V[], close = false): number => {
    g.beginPath();
    let zs = 0;
    ps.forEach((p, i) => {
      const q = X(p);
      zs += q[2];
      if (i) g.lineTo(q[0], q[1]);
      else g.moveTo(q[0], q[1]);
    });
    if (close) g.closePath();
    return near(zs / Math.max(1, ps.length));
  };
  /** smooth 3D curve through points (Catmull-Rom on the projected points) */
  const spline = (ps: V[]): number => {
    const q = ps.map(X);
    g.beginPath();
    g.moveTo(q[0][0], q[0][1]);
    let zs = q[0][2];
    for (let i = 0; i < q.length - 1; i++) {
      const p0 = q[Math.max(0, i - 1)];
      const p1 = q[i];
      const p2 = q[i + 1];
      const p3 = q[Math.min(q.length - 1, i + 2)];
      g.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
      zs += p2[2];
    }
    return near(zs / q.length);
  };
  /** stroke the current path as a glowing line; `depth` 0..1 dims what is on the far side */
  /** opacity of the section being drawn (the cage and the airway fade separately under the coat) */
  let mul = 1;
  const neon = (color: string, width: number, glow = 1, depth = 1) => {
    const a = lerp(0.3, 1, depth) * mul;
    g.lineJoin = "round";
    g.lineCap = "round";
    g.strokeStyle = color;
    g.globalAlpha = 0.14 * glow * a;
    g.lineWidth = width * W * 5;
    g.stroke();
    g.globalAlpha = 0.28 * glow * a;
    g.lineWidth = width * W * 2.4;
    g.stroke();
    g.globalAlpha = a;
    g.lineWidth = width * W * lerp(0.75, 1, depth);
    g.stroke();
    g.globalAlpha = mul;
  };
  const faint = (alpha: number, width = 1) => {
    g.strokeStyle = `rgba(225,205,245,${alpha})`;
    g.lineWidth = W * width;
    g.stroke();
  };
  /** an ellipse standing across the head: centre c, half-height r along n, half-width hz along z, over [a0, a1] */
  const hoop = (c: P, n: P, r: number, hz: number, a0 = 0, a1 = Math.PI * 2, seg = 20): V[] => {
    const out: V[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = a0 + ((a1 - a0) * i) / seg;
      out.push([c[0] + n[0] * r * Math.cos(a), c[1] + n[1] * r * Math.cos(a), hz * Math.sin(a)]);
    }
    return out;
  };

  g.save();
  g.beginPath();
  g.rect(rect.x, rect.y, rect.w, rect.h);
  g.clip();

  const lipU = L.upper[nAll - 1];
  const lipL = L.lower[nAll - 1];
  const jawHinge = L.lower[L.nPh];
  const chinDepth = S * (cat ? 0.2 : 0.17);
  // the underside of the lower jaw hangs from the engine's mouth floor
  const jawUnder: P[] = [];
  for (let i = L.nPh; i < nAll; i++) {
    const n = nrm(dir(L.ang[i]));
    const u = (i - L.nPh) / Math.max(1, nAll - 1 - L.nPh);
    jawUnder.push(add(L.lower[i], n, -chinDepth * lerp(1.6, 0.85, u)));
  }
  /** half-width of the muzzle at oral position u (0 junction … 1 lips) */
  const wMuzzle = (u: number) => lerp(wStop, wLip, sstep(0.15, 1, u));

  // ---- sound leaving the mouth: rings on a widening cone ----
  const mouth: P = [(lipU[0] + lipL[0]) / 2, (lipU[1] + lipL[1]) / 2];
  if (t.outRms > 0.012 && o.time - fx.lastRing > 0.085) {
    fx.rings.push({ r: 0, a: clamp(t.outRms * 4, 0.15, 1) });
    fx.lastRing = o.time;
  }
  fx.rings = fx.rings.filter((r) => r.a > 0.03 && r.r < S * 2.2);
  for (const r of fx.rings) {
    r.r += S * 3.6 * dt;
    r.a *= Math.exp(-dt * 3.2);
    path(hoop(add(mouth, fwd, r.r), up, r.r * 0.32 + S * 0.08, r.r * 0.32 + S * 0.08, 0, Math.PI * 2, 28), true);
    g.strokeStyle = NEON.hot;
    g.globalAlpha = r.a * 0.7;
    g.lineWidth = W * 1.5;
    g.stroke();
  }
  g.globalAlpha = 1;

  const nOr = nAll - L.nPh;

  // ---- the pet's outside: soft filled shapes on the same frame, the same camera ----
  const xr = o.coat ? clamp(o.xray ?? 0) : 1;
  const glow = clamp(fx.level * 1.7);
  const aCage = xr;
  // under the coat the airway shows faintly at rest and lights up through the fur while it sounds
  const aAir = o.coat ? Math.max(xr, 0.1 + 0.8 * glow) : 1;
  const skinA = o.coat ? clamp(1 - 0.78 * xr - 0.22 * glow * (1 - xr)) : 0;
  if (o.coat && skinA > 0.02) {
    // Seen from outside, a shut mouth hides the space inside it: the visible jaw line closes up
    // to the palate as the engine's jaw value falls to rest, and drops with it as it opens.
    const show = sstep(0.05, 0.32, t.frame.jaw);
    const roof: P[] = [];
    const floor: P[] = [];
    const under: P[] = [];
    for (let i = L.nPh; i < nAll; i++) {
      const fl: P = [lerp(L.upper[i][0], L.lower[i][0], show), lerp(L.upper[i][1], L.lower[i][1], show)];
      const u0 = jawUnder[i - L.nPh];
      roof.push(L.upper[i]);
      floor.push(fl);
      under.push([fl[0] + (u0[0] - L.lower[i][0]), fl[1] + (u0[1] - L.lower[i][1])]);
    }
    const nearSide = X([px, py, 1])[2] > X([px, py, -1])[2] ? 1 : -1;
    drawSkin({ g, X, at, fwd, up, lipRest, S, M, k, W, cat, coat: o.coat, time: o.time, level: fx.level, alpha: skinA, roof, floor, under, noseTip, neckTo: add(tEnd, nEnd, S * 0.22), nearSide });
    g.globalAlpha = 1;
  }
  // the nose is a handle: drag it to change the muzzle
  if (o.handles) {
    const q = X(v3(noseTip));
    const pulse = 0.5 + 0.5 * Math.sin(o.time * 3.2);
    g.beginPath();
    g.arc(q[0], q[1], S * 0.16 * k + 3 * pulse * W, 0, Math.PI * 2);
    g.strokeStyle = NEON.lime;
    g.globalAlpha = 0.45 + 0.4 * pulse;
    g.lineWidth = W * 1.6;
    g.setLineDash([4 * W, 4 * W]);
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
  }

  // ---- the head cage (only in see-through view when the pet wears a coat) ----
  mul = aCage;
  g.globalAlpha = mul;
  if (aCage > 0.01) {
  // mid-plane profile: muzzle, forehead, crown, back of the skull, nape
  neon(NEON.soft, 1.5, 1, spline([v3(lipU), v3(add(lipU, fwd, 0.07 * S)), v3(noseTip), v3(add(add(noseTip, up, 0.11 * S), fwd, -0.1 * S)), v3(stop), v3(brow), v3(crown), v3(occiput), v3(add(add(gRest, nG, S * 1.05), back, -S * 0.15)), v3(napeEnd)]));
  // chin, jaw, throat
  const jawAngle = add(jawHinge, nrm(dir(L.ang[L.nPh])), -S * 0.5);
  const throat = add(add(gRest, nG, -S * 0.5), back, -S * 0.1);
  neon(NEON.soft, 1.5, 1, spline([v3(lipL), v3(add(lipL, fwd, 0.05 * S)), ...[...jawUnder].reverse().filter((_, i) => i % 2 === 0).map((p) => v3(p)), v3(jawAngle), v3(throat), v3(throatEnd)]));
  // skull hoops: brow, crown, occiput (decoration, on the rigid frame)
  const skull: { c: P; r: number; hz: number }[] = [
    { c: at(-M - 0.22 * S, cat ? 0.3 * S : 0.26 * S), r: cat ? 0.68 * S : 0.6 * S, hz: wSkull * 0.92 },
    { c: at(-M - 0.72 * S, cat ? 0.36 * S : 0.32 * S), r: cat ? 0.74 * S : 0.68 * S, hz: wSkull },
    { c: at(-M - 1.25 * S, 0.22 * S), r: 0.46 * S, hz: wSkull * 0.74 },
  ];
  for (const h of skull) {
    for (const [a0, a1] of [[0, Math.PI], [Math.PI, 2 * Math.PI]]) {
      const d = path(hoop(h.c, up, h.r, h.hz, a0, a1));
      neon(NEON.soft, 0.9, 0.5, d * 0.85);
    }
  }
  // muzzle: upper half-hoops on the rigid upper jaw, lower half-hoops on the engine's lower jaw
  for (const u of [0.38, 0.68, 0.95]) {
    const i = L.nPh + Math.min(nOr - 1, Math.round(u * (nOr - 1)));
    const hz = wMuzzle(u);
    const topH = lerp(cat ? 0.6 * S : 0.5 * S, cat ? 0.24 * S : 0.26 * S, sstep(0, 1, u));
    for (const [a0, a1] of [[0, Math.PI / 2], [-Math.PI / 2, 0]]) {
      neon(NEON.soft, 0.9, 0.5, path(hoop(L.upper[i], up, topH, hz, a0, a1, 10)) * 0.85);
    }
    const under = jawUnder[i - L.nPh];
    const drop = Math.hypot(L.lower[i][0] - under[0], L.lower[i][1] - under[1]);
    const nn = nrm(dir(L.ang[i]));
    for (const [a0, a1] of [[Math.PI / 2, Math.PI], [Math.PI, 1.5 * Math.PI]]) {
      neon(NEON.soft, 0.9, 0.5, path(hoop(L.lower[i], nn, drop, hz, a0, a1, 10)) * 0.85);
    }
  }
  // lip lines and cheek lines down both sides
  for (const side of [1, -1]) {
    const upperLip: V[] = [];
    const lowerLip: V[] = [];
    for (let i = L.nPh; i < nAll; i++) {
      const u = (i - L.nPh) / Math.max(1, nOr - 1);
      upperLip.push(v3(L.upper[i], side * wMuzzle(u)));
      lowerLip.push(v3(L.lower[i], side * wMuzzle(u)));
    }
    const cheek = v3(at(-M - 0.22 * S, 0.3 * S), side * wSkull * 0.92);
    const temple = v3(at(-M - 0.72 * S, 0.36 * S), side * wSkull);
    const behind = v3(at(-M - 1.25 * S, 0.22 * S), side * wSkull * 0.74);
    neon(NEON.soft, 1.1, 0.6, spline([upperLip[upperLip.length - 1], ...upperLip.filter((_, i) => i % 3 === 0).reverse(), cheek, temple, behind, v3(add(tEnd, nEnd, S * 0.3), side * wNeck)]));
    neon(NEON.soft, 1.1, 0.5, spline([lowerLip[lowerLip.length - 1], ...lowerLip.filter((_, i) => i % 3 === 0).reverse(), v3(jawAngle, side * wStop * 0.9)]) * 0.9);
    // ear
    if (cat) {
      const e0 = v3(at(-M - 0.5 * S, 1.02 * S), side * wSkull * 0.22);
      const e1 = v3(at(-M - 0.98 * S, 0.86 * S), side * wSkull * 0.86);
      const tip = v3(at(-M - 0.74 * S, 1.5 * S), side * wSkull * 0.7);
      neon(NEON.soft, 1.4, 0.9, path([e0, tip, e1]));
      path([v3(at(-M - 0.6 * S, 1.02 * S), side * wSkull * 0.36), v3(at(-M - 0.73 * S, 1.42 * S), side * wSkull * 0.7), v3(at(-M - 0.9 * S, 0.92 * S), side * wSkull * 0.76)]);
      faint(0.3);
    } else {
      const z = side * wSkull * 1.02;
      neon(NEON.soft, 1.2, 0.8, spline([v3(at(-M - 0.5 * S, 0.96 * S), z * 0.8), v3(at(-M - 0.95 * S, 0.84 * S), z), v3(at(-M - 1.06 * S, 0.3 * S), z * 1.08), v3(at(-M - 0.86 * S, 0.02 * S), z * 1.05), v3(at(-M - 0.62 * S, 0.3 * S), z), v3(at(-M - 0.5 * S, 0.96 * S), z * 0.8)]));
    }
    // eye: on the side of the face, narrowing as the call gets loud
    {
      const c = at(-M - 0.2 * S, (cat ? 0.64 : 0.56) * S);
      const z = side * wSkull * (cat ? 0.6 : 0.56);
      const open = lerp(1, 0.3, fx.level);
      const ring: V[] = [];
      for (let i = 0; i <= 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        ring.push([c[0] + fwd[0] * 0.13 * S * Math.cos(a) + up[0] * 0.1 * S * open * Math.sin(a), c[1] + fwd[1] * 0.13 * S * Math.cos(a) + up[1] * 0.1 * S * open * Math.sin(a), z + side * 0.05 * S * Math.cos(a)]);
      }
      const d = path(ring, true);
      neon(NEON.lime, 1.2, 0.9, d);
      const q = X([c[0], c[1], z]);
      g.beginPath();
      g.ellipse(q[0], q[1], S * (cat ? 0.03 : 0.05) * k, S * 0.08 * k * open, 0, 0, Math.PI * 2);
      g.fillStyle = NEON.lime;
      g.globalAlpha = 0.8 * lerp(0.3, 1, d) * mul;
      g.fill();
      g.globalAlpha = mul;
    }
    // whiskers
    if (cat) {
      const w0 = v3(at(-0.14 * S, 0.02 * S), side * wLip * 0.9);
      for (const a of [-16, 0, 16]) {
        const d2 = dir(TH_ORAL + a);
        path([w0, [w0[0] + d2[0] * 0.45 * S, w0[1] + d2[1] * 0.45 * S, w0[2] + side * 0.7 * S]]);
        faint(0.4);
      }
    }
    // side of the neck
    neon(NEON.soft, 0.9, 0.45, spline([v3(jawAngle, side * wStop * 0.9), v3(throat, side * wNeck * 0.8), v3(add(tEnd, nEnd, -S * 0.25), side * wNeck)]) * 0.8);
  }
  // nose pad
  {
    const q = X(v3(noseTip));
    g.beginPath();
    g.arc(q[0], q[1], S * 0.05 * k, 0, Math.PI * 2);
    neon(NEON.hot, 1.1, 0.8);
  }

  }

  // ---- nasal passage: above the palate, from the velum to the nostrils ----
  mul = aAir;
  g.globalAlpha = mul;
  const nNa = t.nasal.length;
  if (nNa > 1) {
    const v0 = add(L.upper[L.nPh], up, 0.03 * S);
    const tip = add(noseTip, up, -0.05 * S);
    const top: V[] = [];
    const bot: V[] = [];
    for (let i = 0; i < nNa; i++) {
      const u = (i + 0.5) / nNa;
      // rise behind the palate, then run forward to the nose
      const base: P = [lerp(v0[0], tip[0], u), lerp(v0[1], tip[1], u)];
      const arch = Math.sin(Math.PI * Math.pow(u, 0.7)) * 0.2 * S;
      const c = add(base, up, arch + 0.1 * S * (1 - u));
      const r = Math.sqrt(t.nasal[i] / Math.PI) * 1.25;
      top.push(v3(add(c, up, r)));
      bot.push(v3(add(c, up, -r)));
      const e = energy(t.nasalRms[i]);
      path(hoop(c, up, r, r * 1.5, 0, Math.PI * 2, 12), true);
      g.strokeStyle = energyColor(e, 0.16 + 0.7 * e);
      g.lineWidth = W * (0.7 + 2 * e);
      g.stroke();
    }
    neon(NEON.line, 0.9, 0.6, path(top));
    neon(NEON.line, 0.9, 0.6, path(bot));
    // velum: a flap hinged on the palate, swung open by the engine's port area
    const openV = clamp(t.velumArea / Math.max(1e-6, body.velumArea));
    const hinge = add(L.upper[L.nPh], fwd, 0.1 * S);
    const flap = add(hinge, dir(TH_JUNCTION + 180 + lerp(55, -12, openV)), 0.24 * S);
    const hz = L.half[L.nPh] * 0.7;
    path([v3(hinge, -hz), v3(flap, -hz), v3(flap, hz), v3(hinge, hz)]);
    neon(NEON.amber, 1.4);
  }

  // ---- trachea: cartilage rings ----
  {
    for (const [dy, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      neon(NEON.line, 0.9, 0.5, path(trachea.map((s) => [s.c[0] + s.n[0] * rTr * dy, s.c[1] + s.n[1] * rTr * dy, rTr * dz] as V)) * 0.9);
    }
    trachea.forEach((s, i) => {
      if (i % 2 === 0) return;
      path(hoop(s.c, s.n, rTr, rTr, 0, Math.PI * 2, 12), true);
      faint(0.32);
    });
  }

  // ---- the airway: one ring per engine section, walls through them ----
  const rms = (i: number) => (i < L.nPh ? t.pharynxRms[i] : t.oralRms[i - L.nPh]);
  const centre = (i: number): P => [(L.upper[i][0] + L.lower[i][0]) / 2, (L.upper[i][1] + L.lower[i][1]) / 2];
  const radius = (i: number) => Math.hypot(L.upper[i][0] - L.lower[i][0], L.upper[i][1] - L.lower[i][1]) / 2;
  for (let i = 0; i < nAll; i++) {
    const e = energy(rms(i));
    path(hoop(centre(i), nrm(dir(L.ang[i])), radius(i), L.half[i], 0, Math.PI * 2, 16), true);
    g.strokeStyle = energyColor(e, 0.2 + 0.75 * e);
    g.lineWidth = W * (0.8 + 2.2 * e);
    g.stroke();
    if (e > 0.25) {
      g.fillStyle = energyColor(e, 0.09 * e);
      g.fill();
    }
  }
  // the rigid roof, the two sides, and the moving floor (the tongue)
  neon(NEON.line, 1.7, 1, path(L.upper.map((p) => v3(p))));
  for (const side of [1, -1]) {
    const d = path(L.upper.map((_, i) => v3(centre(i), side * L.half[i])));
    neon(NEON.line, 1, 0.5, d * 0.9);
  }
  neon(NEON.hot, 1.9, 1, path(L.lower.map((p) => v3(p))));

  // ---- vocal folds: two shelves across the tube, parting sideways by the engine's glottal area ----
  {
    const gapMax = 2 * Math.sqrt(body.foldArea / Math.PI);
    const gap = 2 * Math.sqrt(Math.max(0, t.glottis) / Math.PI);
    const hz = L.half[0];
    const open = clamp(gap / Math.max(1e-6, gapMax * 2.2)) * hz;
    for (const side of [1, -1]) {
      const d = path([v3(glottisUp, side * hz * 0.85), v3(glottisUp, side * open), v3(glottisLo, side * open), v3(glottisLo, side * hz * 0.85)]);
      neon(t.voicing > 0.3 ? NEON.amber : NEON.dim, 2, 0.5 + 0.8 * t.voicing, Math.max(0.6, d));
    }
    // shimmer while they vibrate, brighter the more they move
    if (t.voicing > 0.15) {
      const q = X(v3(gMid));
      const pulse = 0.5 + 0.5 * Math.sin(o.time * 38);
      g.beginPath();
      g.arc(q[0], q[1], (0.06 + 0.05 * pulse) * S * k, 0, Math.PI * 2);
      g.fillStyle = `rgba(255,210,122,${0.3 * t.voicing * (0.6 + 0.4 * pulse) * mul})`;
      g.fill();
    }
  }

  // ---- airflow dots: speed and direction from the engine's glottal flow ----
  {
    const flowRef = body.foldArea * 3500;
    const v = Math.sign(t.flow) * Math.pow(clamp(Math.abs(t.flow) / flowRef), 0.6);
    const vis = clamp(Math.abs(v) * 1.6);
    if (vis > 0.03) {
      for (const dot of fx.dots) {
        dot.s += v * dt * 1.1;
        if (dot.s > 1) dot.s -= 1;
        if (dot.s < 0) dot.s += 1;
        const x = dot.s * (nAll - 1);
        const i = Math.min(nAll - 2, Math.floor(x));
        const u = x - i;
        const pu: P = [lerp(L.upper[i][0], L.upper[i + 1][0], u), lerp(L.upper[i][1], L.upper[i + 1][1], u)];
        const pl: P = [lerp(L.lower[i][0], L.lower[i + 1][0], u), lerp(L.lower[i][1], L.lower[i + 1][1], u)];
        const w = 0.5 + 0.36 * dot.off;
        const hz = lerp(L.half[i], L.half[i + 1], u) * 0.75 * dot.side * Math.sqrt(1 - dot.off * dot.off * 0.8);
        const q = X([lerp(pl[0], pu[0], w), lerp(pl[1], pu[1], w), hz]);
        g.beginPath();
        g.arc(q[0], q[1], W * 1.3, 0, Math.PI * 2);
        g.fillStyle = `rgba(255,210,122,${0.8 * vis * mul})`;
        g.fill();
      }
    }
  }

  mul = 1;
  g.globalAlpha = 1;
  fx.hit = { nose: [X(v3(noseTip))[0], X(v3(noseTip))[1]], unit: S * k };

  // ---- what it just said, popping out over its head ----
  fx.bubbles = fx.bubbles.filter((b) => o.time - b.born < 1.5);
  for (const b of fx.bubbles) {
    const age = (o.time - b.born) / 1.5;
    const q = X(v3(at(-M - 0.2 * S, (cat ? 1.75 : 1.45) * S + age * 0.5 * S)));
    const size = Math.round(17 * clamp(rect.w / 520, 0.9, 1.5) * (0.75 + 0.25 * Math.min(1, age * 8)));
    g.font = `700 ${size}px ui-rounded, "SF Pro Rounded", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
    const tw = g.measureText(b.text).width;
    const bw = tw + size * 1.3;
    const bh = size * 1.9;
    const x0 = clamp(q[0] - bw / 2, rect.x + 6, rect.x + rect.w - bw - 6);
    const y0 = Math.max(rect.y + 6, q[1] - bh);
    g.globalAlpha = clamp(2.2 - age * 2.2);
    g.beginPath();
    g.roundRect(x0, y0, bw, bh, bh / 2);
    g.moveTo(x0 + bw * 0.42, y0 + bh - 1);
    g.lineTo(x0 + bw * 0.46, y0 + bh + size * 0.5);
    g.lineTo(x0 + bw * 0.58, y0 + bh - 1);
    g.fillStyle = NEON.text;
    g.fill();
    g.fillStyle = "#3a2233";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(b.text, x0 + bw / 2, y0 + bh / 2 + 1);
    g.globalAlpha = 1;
  }

  // ---- labels ----
  if (o.labels && aCage > 0.5) {
    g.font = `${Math.round(11 * clamp(rect.w / 520, 0.85, 1.4))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    g.fillStyle = "rgba(255,243,228,0.7)";
    g.textBaseline = "middle";
    const label = (p: P, text: string, dx: number, dy: number, align: CanvasTextAlign = "left") => {
      const q = X(v3(p));
      g.textAlign = align;
      g.fillText(text, q[0] + dx, q[1] + dy);
    };
    label(gMid, "声带", -12 * W, 14 * W, "right");
    label(trachea[Math.floor(trachea.length / 2)].c, "气管", -14 * W, 0, "right");
    label(L.lower[L.nPh + Math.floor(nOr * 0.55)], "舌", 0, 15 * W, "center");
    label(add(L.upper[L.nPh], up, 0.34 * S), "鼻腔", 0, -9 * W, "center");
    // scale bar (true at the head's mid plane)
    const unit = tract > 14 ? 5 : 1;
    const bx = rect.x + 14;
    const by = rect.y + rect.h - 16;
    g.strokeStyle = "rgba(255,243,228,0.55)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(bx, by - 4);
    g.lineTo(bx, by);
    g.lineTo(bx + unit * k, by);
    g.lineTo(bx + unit * k, by - 4);
    g.stroke();
    g.textAlign = "left";
    g.fillText(`${unit} cm`, bx + unit * k + 6, by - 2);
  }
  g.restore();
}
