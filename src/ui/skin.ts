/**
 * The pet's outside, drawn as a shaded, furred head rather than flat shapes.
 *
 * It is still a drawing, not a simulation: the head is a lofted surface (rings along the muzzle
 * axis, sized from species proportions), lit from the upper left, with short fur strokes laid
 * along it, a striped or two-tone coat, and eyes with an iris and a pupil. What moves is real:
 * the lower jaw hangs from the engine's own mouth floor, so the mouth opens exactly as far as
 * the airway's lip sections do, and the head's length follows the body's oral tube.
 *
 * Everything is in the cutaway's frame (cm in the head's mid plane, z across the head) and goes
 * through the cutaway's camera, so the skin and the see-through wireframe stay registered.
 */
type P = [number, number];
type V = [number, number, number];
type RGB = [number, number, number];

export interface SkinCoat {
  fur: string;
  light: string;
  dark: string;
  pink: string;
  nose: string;
  eye: string;
  /** iris colour (falls back to a species default) */
  iris?: string;
  /** tabby: stripes and a pale muzzle; bicolor: pale muzzle, chin and chest; urajiro: pale cheeks, brows and underside; solid */
  pattern?: "tabby" | "bicolor" | "urajiro" | "solid";
  /** dogs: pricked or hanging ears */
  ears?: "erect" | "drop";
}

export interface SkinInput {
  g: CanvasRenderingContext2D;
  /** model (cm) → [screen x, screen y, depth toward the viewer in cm] */
  X: (p: V) => V;
  /** a point of the rigid head frame: f cm along the muzzle from the lips, u cm up */
  at: (f: number, u: number) => P;
  fwd: P;
  up: P;
  lipRest: P;
  /** half the tract, cm: the unit every proportion here is given in */
  S: number;
  /** how far the muzzle stands out in front of the skull, cm */
  M: number;
  /** pixels per cm */
  k: number;
  /** stroke scale */
  W: number;
  cat: boolean;
  coat: SkinCoat;
  time: number;
  /** smoothed loudness 0..1 */
  level: number;
  alpha: number;
  /** oral sections, junction → lips, in the mid plane (cm): palate, mouth floor as seen from outside, underside of the jaw */
  roof: P[];
  floor: P[];
  under: P[];
  noseTip: P;
  /** where the neck fades out */
  neckTo: P;
  /** which side of the head (z sign) faces the viewer */
  nearSide: number;
}

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const css = (c: RGB) => `rgb(${Math.round(clamp(c[0], 0, 255))},${Math.round(clamp(c[1], 0, 255))},${Math.round(clamp(c[2], 0, 255))})`;
/** a fixed pseudo-random number 0..1 for a grid cell, so the fur does not crawl between frames */
const hash = (i: number, j: number, n = 0) => {
  let h = Math.imul(i + 1, 374761393) ^ Math.imul(j + 1, 668265263) ^ Math.imul(n + 1, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const sub3 = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a: V): V => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** light from the upper left, a little in front (view space: x right, y up, z toward the viewer) */
const LIGHT = norm3([-0.45, 0.62, 0.64]);
/** superellipse exponent of the head's cross-sections (1 = ellipse; below 1 is squarer) */
const E = 0.86;
const RING = 44;

/**
 * Head profiles, in units of S, along f (0 at the lips, negative toward the back; m = the
 * muzzle's length): [f, top, bottom, half-width]. Read off skull proportions: a cat's muzzle is
 * short and its cheeks are the widest part of the head; a dog's muzzle is long and narrower.
 */
function profile(cat: boolean, m: number): number[][] {
  const rows = cat
    ? [
        [0.07, 0.17, 0.06, 0.05],
        [0.02, 0.25, -0.02, 0.16],
        [-0.5 * m, 0.41, -0.1, 0.3],
        [-m, 0.62, -0.12, 0.43],
        [-m - 0.22, 1.0, -0.34, 0.7],
        [-m - 0.6, 1.16, -0.42, 0.8],
        [-m - 1.0, 1.08, -0.36, 0.72],
        [-m - 1.32, 0.76, -0.14, 0.46],
        [-m - 1.46, 0.45, 0.1, 0.2],
      ]
    : [
        [0.09, 0.24, 0.08, 0.06],
        [0.03, 0.35, -0.03, 0.19],
        [-0.5 * m, 0.43, -0.12, 0.27],
        [-m, 0.54, -0.14, 0.36],
        [-m - 0.24, 0.86, -0.28, 0.5],
        [-m - 0.62, 1.0, -0.36, 0.57],
        [-m - 1.0, 0.92, -0.3, 0.53],
        [-m - 1.32, 0.64, -0.12, 0.38],
        [-m - 1.46, 0.4, 0.08, 0.18],
      ];
  // Catmull-Rom through the rows, nine steps a span
  const out: number[][] = [];
  const n = rows.length;
  for (let s = 0; s < n - 1; s++) {
    const p0 = rows[Math.max(0, s - 1)];
    const p1 = rows[s];
    const p2 = rows[s + 1];
    const p3 = rows[Math.min(n - 1, s + 2)];
    for (let q = 0; q < 9; q++) {
      const t = q / 9;
      out.push(p1.map((_, c) => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t * t + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t * t * t)));
    }
  }
  out.push(rows[n - 1]);
  return out;
}

interface Prim {
  z: number;
  /** 0 polygon, 1 line, 2 custom */
  kind: 0 | 1 | 2;
  pts?: number[];
  fill?: string;
  a?: number;
  w?: number;
  fn?: (g: CanvasRenderingContext2D) => void;
  /** a face of a furred surface: blurred a little so the facets do not show */
  soft?: boolean;
  neck?: boolean;
}

export function drawSkin(c: SkinInput): void {
  const { X, at, S, k, W, cat, coat } = c;
  const m = c.M / S;
  const prims: Prim[] = [];
  const fur = hex(coat.fur);
  const light = hex(coat.light);
  const dark = hex(coat.dark);
  const pink = hex(coat.pink);
  const pattern = coat.pattern ?? "bicolor";
  const view = (q: V): V => [q[0], -q[1], q[2] * k];
  const model = (f: number, u: number, z: number): V => {
    const p = at(f * S, u * S);
    return [p[0], p[1], z * S];
  };

  /** shade a base colour for a view-space normal */
  const lit = (base: RGB, n: V, gloss = 0): RGB => {
    const d = Math.max(0, dot3(n, LIGHT));
    // soft form shadow, and a darker edge where the surface turns away: it reads as fur depth
    const shade = (0.46 + 0.66 * d) * (0.74 + 0.26 * clamp(n[2] * 1.7));
    const shadow = mix(mix(base, dark, 0.45), [20, 12, 26], 0.35);
    let col = mix(shadow, base, clamp((shade - 0.34) / 0.66));
    if (shade > 1) col = mix(col, [255, 255, 255], (shade - 1) * 0.55);
    if (gloss) col = mix(col, [255, 255, 255], gloss * Math.pow(d, 12));
    return col;
  };

  /**
   * A quad of a mesh. `ref` is a projected point inside the mesh: the face's normal is turned to
   * point away from it. Back faces are dropped unless `twoSided` (then `inner` colours the side
   * that faces the reference direction).
   */
  const quad = (qa: V, qb: V, qc: V, qd: V, ref: V, base: RGB, alpha: number, gloss = 0): V | null => {
    const a = view(qa);
    const b = view(qb);
    const cc = view(qc);
    const d = view(qd);
    let n = norm3(cross3(sub3(cc, a), sub3(d, b)));
    const ctr: V = [(a[0] + b[0] + cc[0] + d[0]) / 4, (a[1] + b[1] + cc[1] + d[1]) / 4, (a[2] + b[2] + cc[2] + d[2]) / 4];
    if (dot3(n, sub3(ctr, view(ref))) < 0) n = [-n[0], -n[1], -n[2]];
    if (n[2] <= 0) return null;
    prims.push({ z: (qa[2] + qb[2] + qc[2] + qd[2]) / 4, kind: 0, pts: [qa[0], qa[1], qb[0], qb[1], qc[0], qc[1], qd[0], qd[1]], fill: css(lit(base, n, gloss)), a: alpha, soft: true });
    return n;
  };

  /** fur: short strokes from a face toward the next ring back, tinted lighter or darker than the coat under them */
  const furStrokes = (qa: V, qb: V, qd: V, n: V, base: RGB, alpha: number, i: number, j: number, seed: number, len: number) => {
    let dx = qd[0] - qa[0];
    let dy = qd[1] - qa[1];
    const l = Math.hypot(dx, dy);
    if (l < 1e-3) return;
    dx /= l;
    dy /= l;
    for (let s = 0; s < 1; s++) {
      const h1 = hash(i, j, seed + s * 3);
      const h2 = hash(i, j, seed + s * 3 + 1);
      const h3 = hash(i, j, seed + s * 3 + 2);
      const x0 = lerp(qa[0], qb[0], h1) + dx * l * h2;
      const y0 = lerp(qa[1], qb[1], h1) + dy * l * h2;
      const ll = len * (0.55 + 0.9 * h3);
      // strands lean down a little as they run back, and catch the light unevenly
      const tone = h3 > 0.5 ? mix(base, [255, 250, 240], 0.3 * (h3 - 0.5)) : mix(base, dark, 0.5 * (0.5 - h3));
      prims.push({ z: qa[2] + 0.015 * S, kind: 1, pts: [x0, y0, x0 + dx * ll + (h1 - 0.5) * ll * 0.3, y0 + dy * ll + 0.18 * ll], fill: css(lit(tone, n)), a: alpha * 0.55, w: W * (0.6 + 0.6 * h2) });
    }
  };

  let neckFade: [P, P] = [c.neckTo, c.neckTo];

  // ---------------------------------------------------------------- head
  const rows = profile(cat, m);
  const NS = rows.length;
  const ringPoint = (r: number[], th: number): V => {
    const s = Math.sin(th);
    const co = Math.cos(th);
    const uc = r[2] + (r[1] - r[2]) * 0.45;
    const u = s >= 0 ? uc + (r[1] - uc) * Math.pow(s, E) : uc - (uc - r[2]) * Math.pow(-s, E);
    return [r[0], u, r[3] * Math.sign(co) * Math.pow(Math.abs(co), E)];
  };
  /** the row at a given f, interpolated */
  const rowAt = (f: number): number[] => {
    for (let i = 0; i < NS - 1; i++) {
      if (f <= rows[i][0] && f >= rows[i + 1][0]) {
        const t = (rows[i][0] - f) / Math.max(1e-9, rows[i][0] - rows[i + 1][0]);
        return rows[i].map((v, q) => lerp(v, rows[i + 1][q], t));
      }
    }
    return f > rows[0][0] ? rows[0] : rows[NS - 1];
  };

  /** the coat at a point of the head (S units) */
  const coatAt = (f: number, u: number, z: number): RGB => {
    const az = Math.abs(z);
    let col = fur;
    if (cat) {
      const muzzle = sstep(-m - 0.1, -m + 0.12, f) * sstep(0.5, 0.3, u);
      const under = sstep(-0.02, -0.24, u);
      const pale = pattern === "solid" ? 0.3 : pattern === "tabby" ? 0.85 : 0.95;
      col = mix(col, light, Math.max(muzzle, under * 0.9) * pale);
      if (pattern === "tabby") {
        // the forehead's lines run front to back; the cheek's fan back from the eye
        const brow = sstep(-m - 0.2, -m - 0.4, f) * sstep(0.56, 0.8, u);
        const cheek = sstep(-m - 0.28, -m - 0.5, f) * sstep(0.62, 0.42, u) * sstep(-0.22, 0.0, u);
        const s1 = Math.pow(0.5 + 0.5 * Math.cos(az * 19), 3);
        const s2 = Math.pow(0.5 + 0.5 * Math.cos((u * 1.25 - f * 0.55) * 14), 3);
        col = mix(col, dark, 0.55 * Math.max(brow * s1, cheek * s2));
      }
      // the bridge of the nose is a shade deeper
      col = mix(col, dark, 0.14 * sstep(-m - 0.05, -0.1, f) * sstep(0.3, 0.45, u) * (1 - sstep(0.05, 0.16, az)));
    } else {
      const muzzleSide = sstep(-m - 0.05, -m + 0.2, f) * sstep(0.34, 0.2, u);
      const under = sstep(0.0, -0.22, u);
      if (pattern === "urajiro") {
        const cheek = sstep(-m - 0.85, -m - 0.5, f) * sstep(0.32, 0.12, u);
        const brow = Math.exp(-(((f + m + 0.3) / 0.09) ** 2 + ((u - 0.84) / 0.07) ** 2 + ((az - 0.24) / 0.09) ** 2));
        col = mix(col, light, Math.max(muzzleSide, cheek, under, brow * 0.9) * 0.95);
      } else if (pattern === "solid") col = mix(col, light, Math.max(muzzleSide, under) * 0.35);
      else col = mix(col, light, Math.max(muzzleSide, under) * 0.9);
      // a darker saddle down the top of the muzzle and skull
      col = mix(col, dark, 0.16 * sstep(0.5, 0.9, u) * (1 - sstep(0.1, 0.3, az)));
    }
    return col;
  };

  // project the whole head once
  const headM: V[][] = [];
  const headQ: V[][] = [];
  const headC: V[] = [];
  for (let i = 0; i < NS; i++) {
    const r = rows[i];
    const pm: V[] = [];
    const pq: V[] = [];
    for (let j = 0; j < RING; j++) {
      const p = ringPoint(r, (2 * Math.PI * j) / RING);
      pm.push(p);
      pq.push(X(model(p[0], p[1], p[2])));
    }
    headM.push(pm);
    headQ.push(pq);
    headC.push(X(model(r[0], r[2] + (r[1] - r[2]) * 0.45, 0)));
  }
  const furLen = S * k * (cat ? 0.13 : 0.11);
  for (let i = 0; i < NS - 1; i++) {
    const ref: V = [(headC[i][0] + headC[i + 1][0]) / 2, (headC[i][1] + headC[i + 1][1]) / 2, (headC[i][2] + headC[i + 1][2]) / 2];
    for (let j = 0; j < RING; j++) {
      const j1 = (j + 1) % RING;
      const a = headM[i][j];
      const d = headM[i + 1][j1];
      const base = coatAt((a[0] + d[0]) / 2, (a[1] + d[1]) / 2, (a[2] + d[2]) / 2);
      const n = quad(headQ[i][j], headQ[i][j1], headQ[i + 1][j1], headQ[i + 1][j], ref, base, 1);
      // the nose tip itself is bare
      if (n && n[2] > 0.04 && i > 3) furStrokes(headQ[i][j], headQ[i][j1], headQ[i + 1][j], n, base, 1, i, j, 0, furLen * (i < 14 ? 0.6 : 1));
    }
  }

  // ---------------------------------------------------------------- neck and chest
  const neckStart = prims.length;
  {
    const from = at(-(m + 0.98) * S, 0.3 * S);
    const to = c.neckTo;
    neckFade = [from, to];
    const len = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
    const d: P = [(to[0] - from[0]) / len, (to[1] - from[1]) / len];
    const n: P = [-d[1], d[0]];
    const front = n[0] * c.fwd[0] + n[1] * c.fwd[1] >= 0 ? 1 : -1;
    const NN = 22;
    const K = 40;
    const ringsQ: V[][] = [];
    const ctrQ: V[] = [];
    for (let i = 0; i <= NN; i++) {
      const t = i / NN;
      const ctr: P = [from[0] + d[0] * len * t, from[1] + d[1] * len * t];
      const ry = lerp(0.5, 0.62, sstep(0, 1, t)) * S;
      const rz = lerp(0.46, 0.6, sstep(0, 1, t)) * S;
      const row: V[] = [];
      for (let j = 0; j < K; j++) {
        const th = (2 * Math.PI * j) / K;
        row.push(X([ctr[0] + n[0] * ry * Math.sin(th), ctr[1] + n[1] * ry * Math.sin(th), rz * Math.cos(th)]));
      }
      ringsQ.push(row);
      ctrQ.push(X([ctr[0], ctr[1], 0]));
    }
    for (let i = 0; i < NN; i++) {
      const t = (i + 0.5) / NN;
      const alpha = 1;
      void t;
      const ref: V = [(ctrQ[i][0] + ctrQ[i + 1][0]) / 2, (ctrQ[i][1] + ctrQ[i + 1][1]) / 2, (ctrQ[i][2] + ctrQ[i + 1][2]) / 2];
      for (let j = 0; j < K; j++) {
        const j1 = (j + 1) % K;
        const s = Math.sin((2 * Math.PI * (j + 0.5)) / K) * front;
        const bib = pattern === "solid" ? 0.25 : 0.9;
        const base = mix(fur, light, sstep(0.25, 0.75, s) * bib);
        const nn = quad(ringsQ[i][j], ringsQ[i][j1], ringsQ[i + 1][j1], ringsQ[i + 1][j], ref, base, alpha);
        if (nn && nn[2] > 0.04 && (i + j) % 2 === 0) furStrokes(ringsQ[i][j], ringsQ[i][j1], ringsQ[i + 1][j], nn, base, alpha, i, j, 40, furLen * 1.5);
      }
    }
  }

  for (let i = neckStart; i < prims.length; i++) prims[i].neck = true;

  // ---------------------------------------------------------------- lower jaw
  const nOr = c.floor.length;
  const fOf = (p: P) => ((p[0] - c.lipRest[0]) * c.fwd[0] + (p[1] - c.lipRest[1]) * c.fwd[1]) / S;
  const j0 = Math.floor(nOr * 0.3);
  {
    const K = 14;
    const ringsQ: V[][] = [];
    const ctrQ: V[] = [];
    const tops: boolean[] = [];
    const add = (fl: P, un: P, w: number) => {
      const row: V[] = [];
      for (let j = 0; j < K; j++) {
        const th = (2 * Math.PI * j) / K;
        const s = Math.sin(th);
        const z = w * S * Math.cos(th);
        if (s >= 0) row.push(X([fl[0] + c.up[0] * 0.02 * S * s, fl[1] + c.up[1] * 0.02 * S * s, z]));
        else {
          const q = -s;
          row.push(X([lerp(fl[0], un[0], q), lerp(fl[1], un[1], q), z]));
        }
      }
      ringsQ.push(row);
      ctrQ.push(X([(fl[0] + un[0]) / 2, (fl[1] + un[1]) / 2, 0]));
    };
    const jEnd = nOr - 1 - Math.max(1, Math.round(nOr * 0.05));
    for (let i = j0; i <= jEnd; i++) add(c.floor[i], c.under[i], rowAt(fOf(c.floor[i]))[3] * lerp(0.8, 0.66, (i - j0) / Math.max(1, jEnd - j0)));
    // the chin: round the front off
    {
      const fl = c.floor[jEnd];
      const un = c.under[jEnd];
      const w = rowAt(fOf(fl))[3] * 0.66;
      add([fl[0] + c.fwd[0] * 0.05 * S, fl[1] + c.fwd[1] * 0.05 * S], [lerp(fl[0], un[0], 0.7) + c.fwd[0] * 0.04 * S, lerp(fl[1], un[1], 0.7) + c.fwd[1] * 0.04 * S], w * 0.45);
    }
    for (let j = 0; j < K; j++) tops.push(Math.sin((2 * Math.PI * (j + 0.5)) / K) > 0.05);
    const chin = pattern === "solid" ? mix(fur, light, 0.3) : light;
    for (let i = 0; i < ringsQ.length - 1; i++) {
      const ref: V = [(ctrQ[i][0] + ctrQ[i + 1][0]) / 2, (ctrQ[i][1] + ctrQ[i + 1][1]) / 2, (ctrQ[i][2] + ctrQ[i + 1][2]) / 2];
      for (let j = 0; j < K; j++) {
        const j1 = (j + 1) % K;
        // on top: the tongue down the middle, dark gums beside it
        const co = Math.abs(Math.cos((2 * Math.PI * (j + 0.5)) / K));
        const base: RGB = tops[j] ? (co < 0.7 ? pink : [92, 34, 52]) : chin;
        const n = quad(ringsQ[i][j], ringsQ[i][j1], ringsQ[i + 1][j1], ringsQ[i + 1][j], ref, base, 1, tops[j] ? 0.25 : 0);
        if (n && !tops[j] && n[2] > 0.04) furStrokes(ringsQ[i][j], ringsQ[i][j1], ringsQ[i + 1][j], n, base, 1, i, j, 80, furLen * 0.7);
      }
    }
  }

  // ---------------------------------------------------------------- inside the mouth, teeth
  {
    const roof: P[] = [];
    const floor: P[] = [];
    for (let i = j0; i < nOr; i++) {
      const a = X([c.roof[i][0], c.roof[i][1], 0]);
      const b = X([c.floor[i][0], c.floor[i][1], 0]);
      roof.push([a[0], a[1]]);
      floor.push([b[0], b[1]]);
    }
    const iFront = nOr - 2;
    const gapCm = Math.hypot(c.roof[iFront][0] - c.floor[iFront][0], c.roof[iFront][1] - c.floor[iFront][1]);
    const zMid = X([c.roof[Math.floor((j0 + nOr) / 2)][0], c.roof[Math.floor((j0 + nOr) / 2)][1], 0])[2];
    if (gapCm > 0.02 * S) {
      prims.push({ z: zMid - 0.25 * S, kind: 0, pts: [...roof, ...[...floor].reverse()].flat(), fill: "#3a1422", a: 1 });
      // canines, upper and lower, both sides; they show once the mouth is properly open
      const show = sstep(0.05 * S, 0.14 * S, gapCm);
      if (show > 0.02) {
        const tooth = (base: P, tip: P, z: number, w: number) => {
          const a = X([base[0] - c.fwd[0] * w, base[1] - c.fwd[1] * w, z]);
          const b = X([base[0] + c.fwd[0] * w, base[1] + c.fwd[1] * w, z]);
          const t = X([tip[0], tip[1], z]);
          prims.push({ z: a[2] - 0.02 * S, kind: 0, pts: [a[0], a[1], b[0], b[1], t[0], t[1]], fill: "#f6efe2", a: show });
        };
        const iu = nOr - 1 - Math.max(1, Math.round(nOr * 0.07));
        const il = nOr - 1 - Math.max(1, Math.round(nOr * 0.04));
        const wz = rowAt(fOf(c.roof[iu]))[3] * S * 0.6;
        const h = Math.min(gapCm * 0.55, (cat ? 0.17 : 0.2) * S);
        for (const side of [-1, 1]) {
          tooth(c.roof[iu], [c.roof[iu][0] - c.up[0] * h, c.roof[iu][1] - c.up[1] * h], side * wz, 0.035 * S);
          tooth(c.floor[il], [c.floor[il][0] + c.up[0] * h * 0.8, c.floor[il][1] + c.up[1] * h * 0.8], side * wz * 0.82, 0.03 * S);
        }
      }
    }
  }

  // ---------------------------------------------------------------- ears
  const sheet = (grid: V[][], refDir: V, outer: RGB, inner: RGB, seed: number) => {
    const q = grid.map((r) => r.map((p) => X(p)));
    for (let i = 0; i < grid.length - 1; i++) {
      for (let j = 0; j < grid[i].length - 1; j++) {
        const a = view(q[i][j]);
        const b = view(q[i][j + 1]);
        const cc = view(q[i + 1][j + 1]);
        const d = view(q[i + 1][j]);
        let n = norm3(cross3(sub3(cc, a), sub3(d, b)));
        // which way is "inside the ear": the reference direction, seen through the camera
        const p0 = grid[i][j];
        const r0 = X(p0);
        const r1 = X([p0[0] + refDir[0], p0[1] + refDir[1], p0[2] + refDir[2]]);
        const rv = sub3(view(r1), view(r0));
        if (dot3(n, rv) < 0) n = [-n[0], -n[1], -n[2]];
        const seesInner = n[2] > 0;
        if (!seesInner) n = [-n[0], -n[1], -n[2]];
        // a thin ear lets light through and is lit from both sides: never as dark as a solid form's shadow
        const nl = norm3([n[0] * 0.5, n[1] * 0.5 + 0.35, n[2] + 0.6]);
        // the inside is pink in the middle and furred at the rim
        const rim = Math.abs(j + 0.5 - (grid[i].length - 1) / 2) / ((grid[i].length - 1) / 2);
        // deeper and darker toward the base, where the ear's cup turns away from the light
        const depth = 1 - (i + 0.5) / (grid.length - 1);
        const base = seesInner ? mix(mix(inner, [70, 30, 40], 0.6 * depth * (1 - rim)), mix(outer, light, 0.35), sstep(0.5, 0.95, rim)) : outer;
        prims.push({ z: (q[i][j][2] + q[i][j + 1][2] + q[i + 1][j + 1][2] + q[i + 1][j][2]) / 4, kind: 0, pts: [q[i][j][0], q[i][j][1], q[i][j + 1][0], q[i][j + 1][1], q[i + 1][j + 1][0], q[i + 1][j + 1][1], q[i + 1][j][0], q[i + 1][j][1]], fill: css(lit(base, nl)), a: 1, soft: true });
        if (!seesInner || rim > 0.55) furStrokes(q[i][j], q[i][j + 1], q[i + 1][j], n, base, 1, i, j, seed, furLen * 0.6);
      }
    }
  };
  const edge = (grid: V[][]) => {
    for (const j of [0, grid[0].length - 1]) {
      const pts: number[] = [];
      let z = 0;
      for (const r of grid) {
        const q = X(r[j]);
        pts.push(q[0], q[1]);
        z += q[2];
      }
      prims.push({ z: z / grid.length + 0.01 * S, kind: 1, pts, fill: css(mix(dark, [30, 18, 30], 0.5)), a: 0.55, w: W * 1.6 });
    }
  };
  const pricked = cat || coat.ears === "erect";
  for (const side of [-1, 1]) {
    const grid: V[][] = [];
    if (pricked) {
      // a cupped triangle: the base runs from the brow back and out along the skull, the cup opens forward and outward
      const wS = cat ? 0.8 : 0.57;
      const A: V = [-m - (cat ? 0.36 : 0.5), cat ? 0.98 : 0.82, side * wS * 0.2];
      const B: V = [-m - (cat ? 1.04 : 0.98), cat ? 0.7 : 0.62, side * wS * 0.98];
      const T: V = [-m - (cat ? 0.84 : 0.82), cat ? 1.5 : 1.32, side * wS * (cat ? 0.74 : 0.78)];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        const row: V[] = [];
        for (let j = 0; j <= 6; j++) {
          const u = j / 6;
          const bulge = Math.sin(Math.PI * u) * (1 - t) * 0.16;
          const bx = lerp(A[0], B[0], u) - bulge;
          const by = lerp(A[1], B[1], u) - bulge * 0.25 + Math.sin(Math.PI * u) * 0.05 * (1 - t);
          const bz = lerp(A[2], B[2], u);
          const tt = Math.pow(t, 0.92);
          row.push(model(lerp(bx, T[0], tt), lerp(by, T[1], tt), lerp(bz, T[2], tt)));
        }
        grid.push(row);
      }
      edge(grid);
      sheet(grid, [c.fwd[0] * S, c.fwd[1] * S, side * 0.6 * S], fur, mix(pink, [150, 78, 84], 0.45), side > 0 ? 120 : 160);
    } else {
      // a hanging ear: set on high at the side of the skull, falling beside the cheek
      const w = 0.57;
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        const row: V[] = [];
        for (let j = 0; j <= 5; j++) {
          const u = j / 5;
          const fTop = lerp(-m - 0.46, -m - 0.98, u);
          const fBot = lerp(-m - 0.3, -m - 0.86, u);
          const uTop = lerp(0.84, 0.76, u);
          const uBot = -0.12 + 0.3 * (2 * u - 1) ** 2;
          const zz = side * (lerp(w * 0.8, w * 1.12, sstep(0, 0.35, t)) + 0.06 * Math.sin(Math.PI * t));
          row.push(model(lerp(fTop, fBot, t), lerp(uTop, uBot, Math.pow(t, 0.9)), zz));
        }
        grid.push(row);
      }
      sheet(grid, [0, 0, -side * S], mix(fur, dark, 0.5), mix(fur, dark, 0.35), side > 0 ? 120 : 160);
    }
  }

  // ---------------------------------------------------------------- nose
  {
    const rf = (cat ? 0.075 : 0.115) * S;
    const ru = (cat ? 0.06 : 0.095) * S;
    const rz = (cat ? 0.09 : 0.125) * S;
    const ctr: P = [c.noseTip[0] - c.fwd[0] * rf * 0.3, c.noseTip[1] - c.fwd[1] * rf * 0.3];
    const noseCol = hex(coat.nose);
    const N = 7;
    const K = 12;
    const q: V[][] = [];
    for (let i = 0; i <= N; i++) {
      const lat = -Math.PI / 2 + (Math.PI * i) / N;
      const row: V[] = [];
      for (let j = 0; j < K; j++) {
        const lon = (2 * Math.PI * j) / K;
        const a = Math.sin(lat) * rf;
        const r = Math.cos(lat);
        row.push(X([ctr[0] + c.fwd[0] * a + c.up[0] * r * Math.sin(lon) * ru, ctr[1] + c.fwd[1] * a + c.up[1] * r * Math.sin(lon) * ru, r * Math.cos(lon) * rz]));
      }
      q.push(row);
    }
    const ref = X([ctr[0], ctr[1], 0]);
    for (let i = 0; i < N; i++) for (let j = 0; j < K; j++) quad(q[i][j], q[i][(j + 1) % K], q[i + 1][(j + 1) % K], q[i + 1][j], ref, noseCol, 1, 0.55);
    // nostrils, and the line down to the lip
    for (const side of [-1, 1]) {
      const p = X([ctr[0] + c.fwd[0] * rf * 0.72 - c.up[0] * ru * 0.15, ctr[1] + c.fwd[1] * rf * 0.72 - c.up[1] * ru * 0.15, side * rz * 0.5]);
      const pn = X([ctr[0] + c.fwd[0] * rf * 1.2, ctr[1] + c.fwd[1] * rf * 1.2, side * rz * 0.7]);
      if (pn[2] > p[2]) prims.push({ z: p[2] + 0.05 * S, kind: 2, fn: (g) => { g.beginPath(); g.ellipse(p[0], p[1], rz * k * 0.2, ru * k * 0.26, 0, 0, Math.PI * 2); g.fillStyle = "rgba(20,10,16,0.75)"; g.fill(); } });
    }
    const a = X([ctr[0] + c.fwd[0] * rf * 0.6 - c.up[0] * ru * 0.9, ctr[1] + c.fwd[1] * rf * 0.6 - c.up[1] * ru * 0.9, 0]);
    const lip = at(0.02 * S, -0.02 * S);
    const b = X([lip[0], lip[1], 0]);
    prims.push({ z: a[2] + 0.06 * S, kind: 1, pts: [a[0], a[1], b[0], b[1]], fill: css(mix(dark, [20, 10, 16], 0.5)), a: 0.7, w: W * 1.2 });
  }

  // ---------------------------------------------------------------- lip line, whisker pads, whiskers
  {
    // the upper lip's edge on each side, from the nose back to the corner of the mouth
    for (const side of [-1, 1]) {
      const th = side > 0 ? -Math.PI * 0.3 : Math.PI + Math.PI * 0.3;
      const line: number[] = [];
      let zs = 0;
      let cnt = 0;
      for (let i = 1; i < NS; i++) {
        if (rows[i][0] < -m - 0.12) break;
        const p = ringPoint(rows[i], th);
        const q = X(model(p[0], p[1], p[2] * 1.01));
        line.push(q[0], q[1]);
        zs += q[2];
        cnt++;
      }
      if (cnt > 1 && side === c.nearSide) prims.push({ z: zs / cnt + 0.04 * S, kind: 1, pts: line, fill: css(mix(dark, [20, 10, 16], 0.45)), a: 0.75, w: W * 1.3 });
      // whiskers stand out from the pad beside the nose
      const pad = rowAt(-0.42 * m);
      const nW = cat ? 5 : 3;
      for (let wI = 0; wI < nW; wI++) {
        const tt = nW > 1 ? wI / (nW - 1) : 0.5;
        const p0 = ringPoint(pad, side > 0 ? lerp(0.25, -0.5, tt) : Math.PI - lerp(0.25, -0.5, tt));
        const lenW = (cat ? 0.8 : 0.3) * (0.8 + 0.3 * hash(wI, side + 2, 7));
        const a = X(model(p0[0] - 0.04 * wI, p0[1], p0[2]));
        const mid = X(model(p0[0] - 0.04 * wI - 0.08 * lenW, p0[1] + lerp(0.12, -0.16, tt) * lenW * 0.6, p0[2] + side * lenW * 0.55));
        const b = X(model(p0[0] - 0.04 * wI - 0.3 * lenW, p0[1] + lerp(0.1, -0.3, tt) * lenW, p0[2] + side * lenW));
        const pa = a;
        prims.push({ z: Math.max(a[2], mid[2]) + 0.03 * S, kind: 2, fn: (g) => { g.beginPath(); g.moveTo(pa[0], pa[1]); g.quadraticCurveTo(mid[0], mid[1], b[0], b[1]); g.strokeStyle = cat ? "rgba(255,252,244,0.8)" : "rgba(60,40,40,0.55)"; g.lineWidth = W * (cat ? 0.7 : 0.6); g.lineCap = "round"; g.stroke(); } });
        // the dot each whisker grows from
        if (side === c.nearSide) prims.push({ z: a[2] + 0.03 * S, kind: 2, fn: (g) => { g.beginPath(); g.arc(pa[0], pa[1], W * 1.1, 0, Math.PI * 2); g.fillStyle = "rgba(60,36,40,0.45)"; g.fill(); } });
      }
    }
  }

  // ---------------------------------------------------------------- eyes
  {
    const iris = hex(coat.iris ?? (cat ? "#c9b33a" : "#6a4424"));
    const blinkPhase = (c.time * 0.23) % 1;
    const blink = blinkPhase < 0.03 ? 0.1 : 1;
    // the eyes narrow as the call gets loud
    const open = lerp(1, 0.5, c.level) * blink;
    const fE = -m - (cat ? 0.2 : 0.2);
    // on the side of the face rather than its front slope, so the eye shows in profile too
    const th0 = Math.asin(Math.pow(cat ? 0.5 : 0.56, 1 / E));
    const rx = (cat ? 0.21 : 0.14) * S;
    const ry = (cat ? 0.18 : 0.12) * S;
    const fwd3: V = [c.fwd[0], c.fwd[1], 0];
    const up3: V = [c.up[0], c.up[1], 0];
    for (const side of [-1, 1]) {
      const th = side > 0 ? th0 : Math.PI - th0;
      const row = rowAt(fE);
      const sp = ringPoint(row, th);
      const p0 = model(sp[0], sp[1], sp[2]);
      // the eye looks forward and out; its long axis runs back along the head, outer corner behind
      const n = norm3([fwd3[0] * 0.6 + up3[0] * 0.1, fwd3[1] * 0.6 + up3[1] * 0.1, side * 0.8]);
      const fn = dot3(fwd3, n);
      const ex = norm3([-(fwd3[0] - n[0] * fn), -(fwd3[1] - n[1] * fn), -(fwd3[2] - n[2] * fn)]);
      const un = dot3(up3, n);
      const ue = dot3(up3, ex);
      const ey = norm3([up3[0] - n[0] * un - ex[0] * ue, up3[1] - n[1] * un - ex[1] * ue, up3[2] - n[2] * un - ex[2] * ue]);
      const C: V = [p0[0] + n[0] * 0.02 * S, p0[1] + n[1] * 0.02 * S, p0[2] + n[2] * 0.02 * S];
      const qc = X(C);
      const qn = X([C[0] + n[0] * 0.3 * S, C[1] + n[1] * 0.3 * S, C[2] + n[2] * 0.3 * S]);
      if (qn[2] - qc[2] < 0.03 * S) continue;
      const qx = X([C[0] + ex[0] * rx, C[1] + ex[1] * rx, C[2] + ex[2] * rx]);
      const qy = X([C[0] + ey[0] * ry, C[1] + ey[1] * ry, C[2] + ey[2] * ry]);
      // highlights sit toward the light whichever eye this is
      const hl = qx[0] - qc[0] > 0 ? -1 : 1;
      prims.push({
        z: qc[2] + 0.06 * S,
        kind: 2,
        fn: (g) => {
          g.save();
          g.transform(qx[0] - qc[0], qx[1] - qc[1], qy[0] - qc[0], qy[1] - qc[1], qc[0], qc[1]);
          const o = Math.max(0.08, open);
          const shape = () => {
            g.beginPath();
            if (cat) {
              // almond, the outer corner higher than the inner
              g.moveTo(-1.04, -0.14 * o);
              g.bezierCurveTo(-0.55, 0.98 * o, 0.45, 1.04 * o, 1.02, 0.26 * o);
              g.bezierCurveTo(0.55, -0.74 * o, -0.45, -0.94 * o, -1.04, -0.14 * o);
            } else {
              g.moveTo(-1.02, -0.04 * o);
              g.bezierCurveTo(-0.6, 0.95 * o, 0.6, 0.95 * o, 1.0, 0.08 * o);
              g.bezierCurveTo(0.6, -0.84 * o, -0.6, -0.84 * o, -1.02, -0.04 * o);
            }
            g.closePath();
          };
          // the dark rim of the lids
          shape();
          g.lineJoin = "round";
          g.lineWidth = 0.26;
          g.strokeStyle = "rgba(24,14,20,0.92)";
          g.stroke();
          g.save();
          shape();
          g.clip();
          g.fillStyle = cat ? css(mix(iris, [20, 14, 10], 0.55)) : "#2a1812";
          g.fillRect(-1.3, -1.3, 2.6, 2.6);
          const gr = g.createRadialGradient(0, 0, 0.1, 0, 0, cat ? 1.0 : 0.8);
          gr.addColorStop(0, css(mix(iris, [255, 250, 200], 0.45)));
          gr.addColorStop(0.6, css(iris));
          gr.addColorStop(1, css(mix(iris, [20, 14, 10], 0.6)));
          g.fillStyle = gr;
          g.beginPath();
          g.arc(0, 0, cat ? 1.05 : 0.8, 0, Math.PI * 2);
          g.fill();
          // pupil: a cat's is a slit that widens in a quiet, wide-open eye; a dog's is round
          g.fillStyle = "#07050a";
          g.beginPath();
          if (cat) g.ellipse(0, 0.02, lerp(0.16, 0.34, clamp(open)), 0.84, 0, 0, Math.PI * 2);
          else g.arc(0, 0, 0.44, 0, Math.PI * 2);
          g.fill();
          // the upper lid's shadow across the eye
          const sh = g.createLinearGradient(0, 1, 0, 0.1);
          sh.addColorStop(0, "rgba(0,0,0,0.55)");
          sh.addColorStop(1, "rgba(0,0,0,0)");
          g.fillStyle = sh;
          g.fillRect(-1.3, 0, 2.6, 1.3);
          g.fillStyle = "rgba(255,255,255,0.92)";
          g.beginPath();
          g.arc(0.4 * hl, 0.4 * o, 0.13, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = "rgba(255,255,255,0.45)";
          g.beginPath();
          g.arc(-0.3 * hl, -0.32 * o, 0.07, 0, Math.PI * 2);
          g.fill();
          g.restore();
          g.restore();
        },
      });
    }
  }

  // ---------------------------------------------------------------- paint, far to near
  // Into a layer of its own: the skin goes see-through as one picture (faces blended one by one
  // would show every seam), and the neck is faded out with a mask.
  const main = c.g;
  const tf = main.getTransform();
  const fresh = (slot: number) => {
    const l = layerFor(main.canvas, slot);
    const g = l.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    g.filter = "none";
    g.clearRect(0, 0, l.width, l.height);
    return [l, g] as const;
  };
  prims.sort((a, b) => a.z - b.z);
  /** one group of primitives as a finished picture: surfaces blurred a little, details crisp */
  const compose = (list: Prim[], slot: number) => {
    const [sharp, gs] = fresh(slot + 1);
    gs.setTransform(tf);
    paint(gs, list, W, 0);
    const [layer, g2] = fresh(slot);
    if (typeof (g2 as { filter?: unknown }).filter !== "string") {
      g2.drawImage(sharp, 0, 0);
      return [layer, g2] as const;
    }
    // the details alone, with the surfaces in front of them cut out
    const [detail, gd] = fresh(slot + 2);
    gd.setTransform(tf);
    paint(gd, list, W, 1);
    // facets and pattern steps melt into fur; the blur thins the outline, so the solid body goes back under it at part strength
    g2.filter = `blur(${(S * k * 0.03 * Math.hypot(tf.a, tf.b)).toFixed(2)}px)`;
    g2.drawImage(sharp, 0, 0);
    g2.filter = "none";
    g2.globalAlpha = 0.35;
    g2.drawImage(sharp, 0, 0);
    g2.globalAlpha = 1;
    g2.drawImage(detail, 0, 0);
    return [layer, g2] as const;
  };
  // The neck is a picture of its own so that it alone fades out; the head goes over it.
  const [neckLayer, gn] = compose(prims.filter((p) => p.neck), 0);
  {
    const a = X([neckFade[0][0], neckFade[0][1], 0]);
    const b = X([neckFade[1][0], neckFade[1][1], 0]);
    gn.setTransform(tf);
    const gr = gn.createLinearGradient(a[0], a[1], b[0], b[1]);
    gr.addColorStop(0, "rgba(0,0,0,0)");
    gr.addColorStop(0.34, "rgba(0,0,0,0)");
    gr.addColorStop(0.92, "rgba(0,0,0,1)");
    gr.addColorStop(1, "rgba(0,0,0,1)");
    gn.globalCompositeOperation = "destination-out";
    gn.fillStyle = gr;
    const far = 4000;
    gn.fillRect(-far, -far, 2 * far, 2 * far);
    gn.globalCompositeOperation = "source-over";
  }
  const [headLayer] = compose(prims.filter((p) => !p.neck), 3);
  main.save();
  main.globalAlpha = c.alpha;
  main.setTransform(1, 0, 0, 1, 0, 0);
  if (c.alpha >= 0.999) {
    main.drawImage(neckLayer, 0, 0);
    main.drawImage(headLayer, 0, 0);
  } else {
    // see-through as one picture, not neck showing through head
    gn.setTransform(1, 0, 0, 1, 0, 0);
    gn.drawImage(headLayer, 0, 0);
    main.drawImage(neckLayer, 0, 0);
  }
  main.restore();
}

const layers = new WeakMap<object, HTMLCanvasElement[]>();
function layerFor(canvas: HTMLCanvasElement | OffscreenCanvas, slot: number): HTMLCanvasElement {
  let set = layers.get(canvas);
  if (!set) {
    set = [];
    layers.set(canvas, set);
  }
  const l = (set[slot] ??= document.createElement("canvas"));
  if (l.width !== canvas.width || l.height !== canvas.height) {
    l.width = canvas.width;
    l.height = canvas.height;
  }
  return l;
}

/** mode 0: everything. mode 1: details only; the surfaces erase what lies behind them. */
function paint(g: CanvasRenderingContext2D, prims: Prim[], W: number, mode: 0 | 1): void {
  g.lineJoin = "round";
  for (const p of prims) {
    const erase = mode === 1 && !!p.soft;
    g.globalCompositeOperation = erase ? "destination-out" : "source-over";
    g.globalAlpha = p.a ?? 1;
    if (p.kind === 0) {
      const q = p.pts!;
      g.beginPath();
      g.moveTo(q[0], q[1]);
      for (let i = 2; i < q.length; i += 2) g.lineTo(q[i], q[i + 1]);
      g.closePath();
      g.fillStyle = p.fill!;
      g.fill();
      // hide the hairline between neighbouring faces
      if ((p.a ?? 1) >= 1) {
        g.strokeStyle = p.fill!;
        g.lineWidth = 0.9;
        g.stroke();
      }
    } else if (p.kind === 1) {
      const q = p.pts!;
      g.beginPath();
      g.moveTo(q[0], q[1]);
      for (let i = 2; i < q.length; i += 2) g.lineTo(q[i], q[i + 1]);
      g.strokeStyle = p.fill!;
      g.lineWidth = p.w ?? W;
      g.lineCap = "round";
      g.stroke();
    } else p.fn!(g);
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = "source-over";
}
