//! Self-oscillating vocal folds: an asymmetric two-mass model.
//!
//! Each fold is two masses on springs, one above the other, coupled by a third spring (Ishizaka &
//! Flanagan 1972; the simplified aerodynamics and the left–right asymmetry follow Steinecke &
//! Herzel 1995). Nothing here says how the opening should look or when it should repeat: air
//! pressure pushes the folds apart, their springs and their collision bring them back, and the
//! pitch is whatever that loop settles on. With the two folds tuned alike it is a clean, steady
//! voice. Detune one of them and it falls into period doubling, pitch breaks and chaos by itself,
//! which is where the harshness of a bark comes from in a real larynx too.
//!
//! The model only supplies the glottal *area*; the airway network computes the flow through it,
//! so the tract loads the folds and the folds see the tract's pressure.
//!
//! Units CGS: cm, g, s, dyn/cm².

use chimera::math::{clamp, exp, js_max, js_min, pow};

// A human-sized fold (Steinecke & Herzel 1995, table 1), converted to CGS.
const M1: f64 = 0.125; // g, lower mass
const M2: f64 = 0.025; // g, upper mass
const K1: f64 = 80_000.0; // dyn/cm
const K2: f64 = 8_000.0;
const KC: f64 = 25_000.0; // coupling spring
const R1: f64 = 20.0; // g/s
const R2: f64 = 20.0;
const D1: f64 = 0.25; // cm, thickness of the lower mass
const D2: f64 = 0.05;
const LEN: f64 = 1.4; // cm, fold length
/// collision springs, as multiples of the masses' own
const COLLISION: f64 = 3.0;
/// share of a pitch rise that comes from stiffer springs (the rest from less moving mass)
pub const STIFF: f64 = 0.25;
/// pitch of the human-sized model at tension 1, Hz (measured on this implementation; see tests)
pub const REF_HZ: f64 = 128.0;
/// peak opening of a scale-1 fold at the tensions pets use, cm² (measured; reads a body's fold
/// area back into a scale)
pub const REF_FOLD_AREA: f64 = 0.11;

#[derive(Clone, Debug)]
pub struct TwoMass {
    dt: f64,
    /// displacement and velocity, [side][mass]; positive is outward (opening)
    x: [[f64; 2]; 2],
    v: [[f64; 2]; 2],
    /// linear size relative to a human fold (lengths ×s, masses ×s³, springs ×s)
    pub scale: f64,
    /// pitch asked for, Hz
    pub target_f0: f64,
    /// rest opening of the lower and upper pair, cm² (negative: pressed together)
    pub rest: [f64; 2],
    /// 0 alike … 1: how far apart the two folds are tuned
    pub asym: f64,
    /// how hard turbulence shakes the folds: random part of the air's push, as a fraction of it
    pub buffet: f64,
    rng: u32,
    /// slow correction of the tension so the pitch lands on the target
    trim: f64,
    // cycle tracking
    t: f64,
    mean_a: f64,
    amp_a: f64,
    above: bool,
    last_cross: f64,
    /// pitch the folds are actually vibrating at, Hz (0 when they are not)
    pub f0: f64,
    /// 0 still … 1 vibrating
    pub voicing: f64,
    /// the opening between the folds now, cm²
    pub area: f64,
}

impl TwoMass {
    pub fn new(fs: f64) -> TwoMass {
        TwoMass {
            dt: 1.0 / fs,
            x: [[0.0; 2]; 2],
            v: [[0.0; 2]; 2],
            scale: 1.0,
            target_f0: REF_HZ,
            rest: [0.05, 0.05],
            asym: 0.0,
            buffet: 0.0,
            rng: 0x2545f491,
            trim: 1.0,
            t: 0.0,
            mean_a: 0.0,
            amp_a: 0.0,
            above: false,
            last_cross: -1.0,
            f0: 0.0,
            voicing: 0.0,
            area: 0.0,
        }
    }

    /// Advance one sample under subglottal pressure `ps` and supraglottal `pv` (gauge, dyn/cm²).
    /// Returns the opening, cm² (never negative).
    #[inline]
    pub fn step(&mut self, ps: f64, pv: f64) -> f64 {
        let s = self.scale;
        let l = LEN * s;
                let q0 = clamp(self.target_f0 * s / REF_HZ * self.trim, 0.15, 14.0);
        let a1 = self.rest[0] + l * (self.x[0][0] + self.x[1][0]);
        let a2 = self.rest[1] + l * (self.x[0][1] + self.x[1][1]);
        let amin = js_min(a1, a2);
        // pressure on each pair: Bernoulli down to the narrowest point, a free jet above it
        let (p1, p2) = if a1 > 0.0 && a2 > 0.0 {
            let r = amin / a1;
            (ps - (ps - pv) * r * r, pv)
        } else if a1 > 0.0 {
            (ps, pv) // shut at the top: the full pressure below reaches the lower masses
        } else {
            (pv, pv) // shut at the bottom
        };
        let f = [l * D1 * s * p1, l * D2 * s * p2];
        let m = [M1 * s * s * s, M2 * s * s * s];
        let k = [K1 * s, K2 * s];
        let r = [R1 * s * s, R2 * s * s];
        let kc = KC * s;
        let a = [a1, a2];
        for side in 0..2 {
            // one fold tighter than asked, the other slacker by as much
            let q = if side == 0 { q0 * (1.0 + 0.2 * self.asym) } else { q0 * (1.0 - 0.5 * self.asym) };
            // Pitch ∝ q. A larynx raises pitch both by stretching the folds stiffer and by letting
            // less of them swing (at the top of the range only the thin edge moves): the springs
            // take q^STIFF of it, the masses the rest. Damping follows so the folds ring alike
            // at any pitch.
            let kq = pow(q, 2.0 * STIFF);
            let mq = pow(q, 2.0 * STIFF - 2.0);
            let rq = pow(q, 2.0 * STIFF - 1.0);
            for i in 0..2 {
                let j = 1 - i;
                let collide = if a[i] < 0.0 { COLLISION * k[i] * kq * a[i] / (2.0 * l) } else { 0.0 };
                // the air stream is not smooth: it buffets the folds
                self.rng ^= self.rng << 13;
                self.rng ^= self.rng >> 17;
                self.rng ^= self.rng << 5;
                let gust = 1.0 + self.buffet * ((self.rng as f64 / 4294967295.0) * 2.0 - 1.0);
                let force = f[i] * gust - r[i] * rq * self.v[side][i] - k[i] * kq * self.x[side][i] - collide - kc * kq * (self.x[side][i] - self.x[side][j]);
                self.v[side][i] += force / (m[i] * mq) * self.dt;
            }
            for i in 0..2 {
                self.x[side][i] += self.v[side][i] * self.dt;
                // a runaway (absurd input) must not poison the airway
                if !self.x[side][i].is_finite() || self.x[side][i].abs() > 4.0 * s {
                    self.x[side][i] = 0.0;
                    self.v[side][i] = 0.0;
                }
            }
        }
        let open = js_max(0.0, amin);
        self.area = open;

        // what pitch did that come out at? upward crossings of the opening through its own mean
        self.t += self.dt;
        let period = 1.0 / js_max(20.0, self.target_f0);
        let slow = 1.0 - exp(-self.dt / (3.0 * period));
        self.mean_a += (open - self.mean_a) * slow;
        let dev = open - self.mean_a;
        self.amp_a += (dev.abs() - self.amp_a) * slow;
        let hyst = 0.25 * self.amp_a;
        if !self.above && dev > hyst {
            self.above = true;
            if self.last_cross >= 0.0 {
                let p = self.t - self.last_cross;
                if p > 0.3 * period && p < 3.5 * period {
                    let f0 = 1.0 / p;
                    self.f0 = if self.f0 > 0.0 { self.f0 + (f0 - self.f0) * 0.5 } else { f0 };
                    // steer the tension toward the target, a little per cycle; not while the folds
                    // are detuned, where the period is no longer one number
                    if self.asym < 0.12 {
                        self.trim = clamp(self.trim * pow(self.target_f0 / f0, 0.18), 0.5, 2.2);
                    }
                }
            }
            self.last_cross = self.t;
        } else if self.above && dev < -hyst {
            self.above = false;
        }
        // vibrating: a cycle seen lately, and a swing worth the name
        let lately = self.last_cross >= 0.0 && self.t - self.last_cross < 2.5 * period;
        let swinging = self.amp_a > 0.004 * s * s;
        let goal = if lately && swinging { 1.0 } else { 0.0 };
        self.voicing += (goal - self.voicing) * (1.0 - exp(-self.dt / 0.012));
        if self.voicing < 0.05 {
            self.f0 = 0.0;
        }
        open
    }

    /// Where in its cycle the opening is, 0..1 (for the picture).
    pub fn cycle_phase(&self) -> f64 {
        if self.f0 <= 0.0 || self.last_cross < 0.0 {
            return 0.0;
        }
        let x = (self.t - self.last_cross) * self.f0;
        x - x.floor()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The folds alone, against a fixed pressure drop with a crude flow-dependent supraglottal
    /// pressure (no airway): does the loop sing, and at what pitch?
    fn run(scale: f64, target: f64, asym: f64, cm_h2o: f64, secs: f64) -> (f64, f64, Vec<f64>) {
        let fs = 96000.0;
        let mut f = TwoMass::new(fs);
        f.scale = scale;
        f.target_f0 = target;
        f.asym = asym;
        f.buffet = 4.0 * asym;
        f.rest = [0.033 * scale * scale, 0.03 * scale * scale];
        let ps = cm_h2o * 980.665;
        let mut areas = Vec::new();
        for _ in 0..(secs * fs) as usize {
            let a = f.step(ps, 0.0);
            assert!(a.is_finite());
            areas.push(a);
        }
        (f.f0, f.voicing, areas)
    }

    #[test]
    fn a_human_sized_fold_sings_near_its_reference_pitch() {
        let (f0, voicing, _) = run(1.0, REF_HZ, 0.0, 8.0, 0.6);
        assert!(voicing > 0.9, "voicing {voicing}");
        assert!((f0 / REF_HZ - 1.0).abs() < 0.05, "f0 {f0}");
    }

    #[test]
    fn it_follows_the_pitch_asked_for_at_cat_and_dog_sizes() {
        for (scale, target) in [(0.45, 600.0), (0.45, 350.0), (0.45, 1000.0), (0.25, 1300.0), (0.95, 350.0), (1.5, 200.0), (0.95, 900.0)] {
            let (f0, voicing, _) = run(scale, target, 0.0, 9.0, 0.5);
            assert!(voicing > 0.9, "scale {scale} target {target}: voicing {voicing}");
            assert!((f0 / target - 1.0).abs() < 0.06, "scale {scale} target {target}: f0 {f0}");
        }
    }

    #[test]
    fn no_pressure_no_voice() {
        let (_, voicing, areas) = run(0.45, 600.0, 0.0, 0.0, 0.3);
        assert!(voicing < 0.05);
        let last = &areas[areas.len() - 2000..];
        assert!(last.iter().cloned().fold(0.0, f64::max) - last.iter().cloned().fold(f64::INFINITY, f64::min) < 1e-6);
    }

    #[test]
    fn detuned_buffeted_folds_stop_repeating_exactly() {
        // cycle-to-cycle variation of the peak opening: tiny when the folds match, large when not
        let spread = |asym: f64| {
            let (_, _, a) = run(0.95, 350.0, asym, 14.0, 0.8);
            let tail = &a[a.len() / 2..];
            let mut peaks = Vec::new();
            for i in 1..tail.len() - 1 {
                if tail[i] > tail[i - 1] && tail[i] >= tail[i + 1] && tail[i] > 0.01 {
                    peaks.push(tail[i]);
                }
            }
            let m = peaks.iter().sum::<f64>() / peaks.len().max(1) as f64;
            (peaks.iter().map(|p| (p - m) * (p - m)).sum::<f64>() / peaks.len().max(1) as f64).sqrt() / m.max(1e-9)
        };
        let (clean, harsh) = (spread(0.0), spread(0.6));
        assert!(clean < 0.03, "matched folds vary by {clean}");
        assert!(harsh > 4.0 * clean.max(0.01), "detuned folds vary by {harsh} (matched {clean})");
    }
}

