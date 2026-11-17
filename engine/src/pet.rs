//! The sounding layer: a pet's airway and voice source, driven by a structured parameter frame.
//!
//! Everything acoustic is CHIMERA's (vendor/chimera, MIT): the branched FDTD airway
//! (`AirwayNetwork`), the mammal topology (`mammal_airway`: lungs → trachea → glottis →
//! pharynx ─┬─ oral → lips, └─ velum → nasal → nostrils), the parametric glottal-area source (now
//! only for purrs) and the decimator. The voice proper comes from self-oscillating folds, which
//! are ours (folds.rs). This file adds what CHIMERA has no preset for: a body that is set from numbers
//! (so a cat, a dog, a kitten are the same code with different tubes), an articulation frame
//! (jaw, lips, tongue, velum, larynx) turned into area functions, and keyframed tracks.
//!
//! Two inputs, both plain f64 arrays (layouts below, mirrored in `src/params/protocol.ts`):
//!  - BODY  (static anatomy): rebuilds the network. Allocates; a short fade hides the swap.
//!  - FRAME (dynamic state): what the voice is doing right now. Either held live, or played from
//!    a track of keyframes with sample-accurate timing inside the engine.

use chimera::airway::decimator::Decimator;
use chimera::airway::network::{NoiseSpec, Tube};
use chimera::creatures::build::CMH2O;
use chimera::creatures::mammal::{MammalAirway, MammalSpec, mammal_airway};
use crate::folds::{REF_FOLD_AREA, TwoMass};
use chimera::math::{PI, clamp, cos, exp, js_max, js_min, pow, sin, smoothstep, sqrt, tanh};

// ---- BODY layout -------------------------------------------------------------------------
pub const B_TRACHEA_LEN: usize = 0; // cm
pub const B_TRACHEA_AREA: usize = 1; // cm²
pub const B_PHARYNX_LEN: usize = 2;
pub const B_PHARYNX_AREA: usize = 3;
pub const B_ORAL_LEN: usize = 4;
pub const B_ORAL_AREA: usize = 5;
pub const B_NASAL_LEN: usize = 6;
pub const B_NASAL_AREA: usize = 7;
/// peak vibratory glottal area at full effort (cm²)
pub const B_FOLD_AREA: usize = 8;
/// phonation threshold pressure (cmH₂O)
pub const B_THRESHOLD: usize = 9;
/// fraction of wall motion radiated through the skin (purrs and growls are heard through the body)
pub const B_WALL_RADIATION: usize = 10;
/// widest velum port (cm²)
pub const B_VELUM_AREA: usize = 11;
/// output normalisation (the parameter layer computes it from the body's size)
pub const B_GAIN: usize = 12;
/// widest the lips open relative to the oral tube's area (a carnivore's gape is a horn)
pub const B_GAPE: usize = 13;
pub const N_BODY: usize = 14;

// ---- FRAME layout ------------------------------------------------------------------------
pub const F_F0: usize = 0; // Hz
/// lung pressure, cmH₂O. Negative is ingressive (the inhaled half of a purr).
pub const F_PRESSURE: usize = 1;
/// jaw / mouth opening 0..1 (0 seals the lips)
pub const F_JAW: usize = 2;
/// lip rounding and protrusion 0..1 (narrows the lips, lengthens the oral tube)
pub const F_ROUND: usize = 3;
/// where the tongue narrows the tract: 0 pharynx … 1 just behind the teeth
pub const F_TONGUE_POS: usize = 4;
/// how much it narrows: 0 none … 1 nearly closed
pub const F_TONGUE_HEIGHT: usize = 5;
/// fold adduction / tension 0..1: slack and flowy → pressed and bright
pub const F_TENSION: usize = 6;
/// abduction 0..1: breathy, and above ~0.85 the folds stop vibrating (hiss, pant)
pub const F_BREATH: usize = 7;
/// subharmonics → deterministic chaos 0..1 (harsh barks, yowls)
pub const F_ROUGH: usize = 8;
/// vocal fry 0..1 (creak, purr pulses)
pub const F_FRY: usize = 9;
/// turbulence at the narrowest point of the mouth 0..1
pub const F_HISS: usize = 10;
/// depth 0..1 of a ~25 Hz pulse on the breath (trills, chirrups)
pub const F_PULSE_DEPTH: usize = 11;
/// vibrato depth, cents
pub const F_VIBRATO: usize = 12;
/// larynx lowering 0..1 (lengthens the pharynx: howls, growls sounding bigger)
pub const F_LARYNX: usize = 13;
pub const N_FRAME: usize = 14;
/// rate of the breath pulse, Hz. A frame field once; varying it moved the sound by under 1 dB.
const PULSE_HZ: f64 = 25.0;
/// one track key: time (s) then a frame
pub const KEY_SIZE: usize = 1 + N_FRAME;

/// Smoothing time constant (s) per frame field, applied on top of track interpolation and live
/// changes, so nothing steps (a step in area at high flow radiates as a click).
const SMOOTH: [f64; N_FRAME] = [0.006, 0.008, 0.012, 0.02, 0.02, 0.02, 0.015, 0.015, 0.03, 0.03, 0.015, 0.02, 0.05, 0.04];

/// Telemetry header (f32), followed by pharynx/oral/nasal areas, then their pressure RMS.
pub const T_CLOCK: usize = 0;
pub const T_TRACK_TIME: usize = 1; // −1 when no track plays
pub const T_OUT_RMS: usize = 2;
pub const T_GLOTTIS: usize = 3; // mean glottal area since the last read (cm²)
pub const T_VOICING: usize = 4;
pub const T_F0: usize = 5;
pub const T_VELUM: usize = 6; // port area cm²
pub const T_N_PH: usize = 7;
pub const T_N_OR: usize = 8;
pub const T_N_NA: usize = 9;
pub const T_LEN_PH: usize = 10;
pub const T_LEN_OR: usize = 11;
pub const T_LEN_NA: usize = 12;
pub const T_GATE: usize = 13;
pub const T_FOLD_PHASE: usize = 14;
pub const T_FLOW: usize = 15; // mean glottal volume velocity cm³/s (signed)
pub const T_FRAME: usize = 16; // the smoothed frame, N_FRAME values
pub const T_HEADER: usize = T_FRAME + N_FRAME;
const MAX_TUBE_N: usize = 120;

/// area of the tube just above the folds, relative to the pharynx. Tuned against real recordings:
/// a tight one (0.45) rang around 3–4 kHz far more than real meows and barks do.
const EPI_NARROW: f64 = 0.75;
/// corner of the output's one-pole low-pass, Hz: the air and the microphone between a pet and a
/// recording. Real meows and barks fall away above 4–5 kHz; the bare model does not.
const MIC_LOWPASS_HZ: f64 = 4200.0;
/// EMPIRICAL: that corner is for a cat-sized head (an 8.5 cm tract) and falls with the square root
/// of the tract's length. Real barks fall away from about 2 kHz, real meows from about 4 kHz; with
/// one corner for both, barks came out 6–10 dB too bright above 3 kHz.
const MIC_REF_TRACT: f64 = 8.5;
/// The room a pet is recorded in: a small, damped one. Every real recording we compare against
/// has one, and a voice with none sounds as if it were inside the listener's head.
const ROOM_MIX: f64 = 0.16;
const ROOM_RT60: f64 = 0.28; // seconds
const ROOM_COMBS_MS: [f64; 4] = [23.1, 29.7, 37.1, 41.3];
const ROOM_ALLPASS_MS: [f64; 2] = [5.0, 1.7];

/// A small Schroeder room: four damped combs in parallel, two all-passes in series.
struct Room {
    combs: [Vec<f64>; 4],
    ci: [usize; 4],
    cg: [f64; 4],
    damp: [f64; 4],
    aps: [Vec<f64>; 2],
    ai: [usize; 2],
}
impl Room {
    fn new(fs: f64) -> Room {
        let len = |ms: f64| js_max(2.0, (ms * 0.001 * fs).round()) as usize;
        let mut cg = [0.0; 4];
        for i in 0..4 {
            cg[i] = pow(10.0, -3.0 * ROOM_COMBS_MS[i] * 0.001 / ROOM_RT60);
        }
        Room {
            combs: [vec![0.0; len(ROOM_COMBS_MS[0])], vec![0.0; len(ROOM_COMBS_MS[1])], vec![0.0; len(ROOM_COMBS_MS[2])], vec![0.0; len(ROOM_COMBS_MS[3])]],
            ci: [0; 4],
            cg,
            damp: [0.0; 4],
            aps: [vec![0.0; len(ROOM_ALLPASS_MS[0])], vec![0.0; len(ROOM_ALLPASS_MS[1])]],
            ai: [0; 2],
        }
    }
    /// the reflections for one input sample (the direct sound is not included)
    fn step(&mut self, x: f64) -> f64 {
        let mut y = 0.0;
        for i in 0..4 {
            let buf = &mut self.combs[i];
            let out = buf[self.ci[i]];
            // soft furnishings: the echoes lose their top faster than their bottom
            self.damp[i] += (out - self.damp[i]) * 0.45;
            buf[self.ci[i]] = x + self.damp[i] * self.cg[i];
            self.ci[i] = (self.ci[i] + 1) % buf.len();
            y += out;
        }
        y *= 0.25;
        for i in 0..2 {
            let buf = &mut self.aps[i];
            let d = buf[self.ai[i]];
            let v = y + 0.5 * d;
            buf[self.ai[i]] = v;
            self.ai[i] = (self.ai[i] + 1) % buf.len();
            y = d - 0.5 * v;
        }
        y
    }
}
/// gain of the turbulence at the glottis. Real meows and barks are far breathier than the bare
/// pulse (harmonics-to-noise around 10–20 dB, not 30+).
const ASPIRATION: f64 = 7.0e-6;
/// depth of the breath-noise flutter on the glottal opening at breath 0.65 (tuned to real recordings)
const BREATH_NOISE: f64 = 1.5;
/// the flutter is low-passed here: the noise in real calls sits with the voice, not above it
const BREATH_NOISE_HZ: f64 = 1200.0;

/// rest opening of the folds per unit scale², cm²: slack, and how much full tension closes it
const REST_OPEN: f64 = 0.03;
const REST_PRESS: f64 = 0.03;
/// how far `rough` detunes one fold from the other
const ASYM_ROUGH: f64 = 0.6;
/// how hard the air stream shakes the folds at full `rough` (fraction of its steady push)
const BUFFET: f64 = 2.5;

const COMP_THRESHOLD: f64 = 0.02;
const COMP_RATIO: f64 = 3.0;
/// brings a 0.5 peak back to about 0.5 after 3:1 compression
const COMP_MAKEUP: f64 = 7.0;
pub const TELE_MAX: usize = T_HEADER + 6 * MAX_TUBE_N;

/// The velum follows the lips: wide open while they are sealed (the sound has nowhere else to
/// go: hums, purrs, the "m" of a meow), nearly shut once the mouth opens. It was a frame field;
/// ablation showed that steering it separately changed the sound by about 1 dB at most.
fn velum_for(jaw: f64) -> f64 {
    0.2 + 0.8 * (1.0 - smoothstep(0.03, 0.22, jaw))
}

pub fn default_body() -> [f64; N_BODY] {
    // an adult cat, roughly; the parameter layer always sends its own
    [8.0, 0.35, 3.2, 0.7, 5.3, 1.1, 5.0, 0.35, 0.035, 1.6, 0.5, 0.25, 1.0, 1.6]
}

pub fn rest_frame() -> [f64; N_FRAME] {
    [500.0, 0.0, 0.1, 0.0, 0.5, 0.0, 0.5, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
}

struct Sim {
    a: MammalAirway,
    body: [f64; N_BODY],
    nasal_area: Vec<f64>,
    pulse_phase: f64,
    /** breath noise on the glottal opening: depth, a smoothed random value, its generator */
    flutter: f64,
    flutter_lp: f64,
    flutter_coef: f64,
    rng: u32,
    /** the self-oscillating folds, and how much of the opening is theirs (the rest is the
    prescribed pulse, which still does purrs: see `control`) */
    folds: TwoMass,
    fold_mix: f64,
    vib_phase: f64,
}

impl Sim {
    fn new(fs: f64, body: &[f64; N_BODY]) -> Sim {
        let b = body;
        let spec = MammalSpec {
            trachea: (b[B_TRACHEA_LEN], b[B_TRACHEA_AREA]),
            pharynx: (b[B_PHARYNX_LEN], b[B_PHARYNX_AREA]),
            oral: (b[B_ORAL_LEN], b[B_ORAL_AREA]),
            nasal: Some((b[B_NASAL_LEN], b[B_NASAL_AREA])),
            wall: None,
            wall_radiation: Some(b[B_WALL_RADIATION]),
            coarse: None,
            nasal_radiates: None,
        };
        let mut a = mammal_airway(fs, spec, |_, _| {});
        a.glottis_src.threshold = b[B_THRESHOLD] * CMH2O;
        let n_na = a.nasal.map_or(0, |t| t.n);
        Sim { a, body: *body, nasal_area: vec![0.0; n_na], pulse_phase: 0.0, flutter: 0.0, flutter_lp: 0.0, flutter_coef: 1.0 - exp((-2.0 * PI * BREATH_NOISE_HZ) / fs), rng: 0x9e3779b9, folds: TwoMass::new(fs), fold_mix: 1.0, vib_phase: 0.0 }
    }

    /// Frame → lung pressure, glottis settings, area functions, tube lengths, noise sources.
    fn control(&mut self, f: &[f64; N_FRAME], gate: f64, dt: f64) {
        let b = &self.body;
        let a = &mut self.a;

        // breath, with an optional pulse (the seal's trill mechanism: a slow valve on the breath)
        self.pulse_phase += PULSE_HZ * dt;
        self.pulse_phase -= self.pulse_phase.floor();
        let pd = clamp(f[F_PULSE_DEPTH], 0.0, 1.0);
        let pulse = 1.0 - pd + pd * (0.5 - 0.5 * cos(2.0 * PI * self.pulse_phase));
        a.net.set_fixed_pressure(a.lungs, f[F_PRESSURE] * CMH2O * gate * pulse);

        // source
        // (once the folds are wide apart and silent, the hiss comes from the mouth's own turbulence
        // source; the flutter steps back so it does not swamp it)
        let br = clamp(f[F_BREATH], 0.0, 1.0);
        self.flutter = BREATH_NOISE * (0.1 + 1.6 * js_min(br, 0.5)) * (1.0 - 0.8 * smoothstep(0.7, 0.95, br));
        let tension = clamp(f[F_TENSION], 0.0, 1.0);
        let breath = clamp(f[F_BREATH], 0.0, 1.0);
        let rough = clamp(f[F_ROUGH], 0.0, 1.0);
        let fold = b[B_FOLD_AREA];
        let voiced = 1.0 - smoothstep(0.8, 0.95, breath);
        let g = &mut a.glottis_src.params;
        g.f0 = js_max(8.0, f[F_F0]);
        g.amplitude = fold * voiced;
        g.open_quotient = clamp(0.72 - 0.34 * tension + 0.2 * breath, 0.3, 0.95);
        g.skew = 0.6 + 0.12 * tension;
        g.closure_sharpness = clamp(0.25 + 0.7 * tension - 0.3 * breath, 0.05, 1.0);
        g.effort = 0.35 + 0.6 * tension;
        g.chink = fold * (0.03 + 0.25 * breath);
        // past the point where voicing stops the folds swing wide open, so the pressure drop (and the
        // turbulence) moves to the mouth: a hiss, a pant
        g.abduction = fold * (2.5 * breath * breath + 9.0 * smoothstep(0.8, 1.0, breath));
        g.chaos = 0.8 * rough;
        g.diplophonia = 0.5 * smoothstep(0.1, 0.4, rough) * (1.0 - smoothstep(0.5, 0.8, rough));
        g.fry = clamp(f[F_FRY], 0.0, 1.0);
        g.jitter = 0.002 + 0.01 * rough;
        g.shimmer = 0.03 + 0.12 * rough;
        g.vibrato_depth = f[F_VIBRATO];
        g.vibrato_rate = 5.5;
        g.drift = 4.0;

        // The folds proper: two masses a side, set swinging by the breath (folds.rs). The frame
        // sets what a larynx sets: how long and stiff the folds are held (pitch), how far apart
        // they rest (pressed … breathy … wide open and silent), and how unlike the two are.
        // A purr is not this mechanism (the folds are twitched by the laryngeal muscles 25 times
        // a second rather than blown), so below ~60–90 Hz the prescribed pulse keeps the job.
        self.fold_mix = smoothstep(60.0, 90.0, f[F_F0]);
        self.vib_phase += 5.5 * dt;
        self.vib_phase -= self.vib_phase.floor();
        let fo = &mut self.folds;
        let s = sqrt(fold / REF_FOLD_AREA);
        fo.scale = s;
        fo.target_f0 = js_max(40.0, f[F_F0]) * pow(2.0, f[F_VIBRATO] / 1200.0 * sin(2.0 * PI * self.vib_phase));
        let upper = s * s * (REST_OPEN - REST_PRESS * tension + 0.02 * breath + 0.05 * breath * breath) + fold * 9.0 * smoothstep(0.8, 1.0, breath);
        fo.rest = [upper * 1.1 + 0.003 * s * s, upper];
        fo.asym = clamp(ASYM_ROUGH * rough + 0.3 * g.fry, 0.0, 1.0);
        fo.buffet = BUFFET * (0.15 + rough);

        // articulation → area functions. s runs 0..1 from the glottis to the lips across both tubes.
        let jaw = clamp(f[F_JAW], 0.0, 1.0);
        let round = clamp(f[F_ROUND], 0.0, 1.0);
        let th = clamp(f[F_TONGUE_HEIGHT], 0.0, 1.0);
        let tc = 0.22 + 0.62 * clamp(f[F_TONGUE_POS], 0.0, 1.0);
        let larynx = clamp(f[F_LARYNX], 0.0, 1.0);
        let l_ph = b[B_PHARYNX_LEN] * (1.0 + 0.25 * larynx);
        let l_or = b[B_ORAL_LEN] * (1.0 + 0.14 * round);
        let split = l_ph / (l_ph + l_or);
        // the tongue is one mass: where it bunches the tract narrows, and it leaves room elsewhere
        let away = if tc > 0.55 { tc - 0.42 } else { tc + 0.42 };
        let tongue = |s: f64| -> f64 {
            let g1 = exp(-((s - tc) / 0.13) * ((s - tc) / 0.13));
            let g2 = exp(-((s - away) / 0.2) * ((s - away) / 0.2));
            (1.0 - 0.9 * th * g1) * (1.0 + 0.5 * th * g2)
        };
        let a_ph = b[B_PHARYNX_AREA];
        let a_or = b[B_ORAL_AREA];
        let gape = b[B_GAPE];
        let ph = a.pharynx;
        for i in 0..ph.n {
            let u = (i as f64 + 0.5) / ph.n as f64;
            // the tube just above the folds stays narrow (epilarynx), then opens into the pharynx
            let epi = EPI_NARROW + (1.0 - EPI_NARROW) * smoothstep(0.0, 0.35, u);
            a.phar_area[i] = a_ph * epi * tongue(u * split) * (1.0 + 0.3 * larynx);
        }
        a.net.set_tube_targets(ph, &a.phar_area, Some(l_ph), None);
        let or = a.oral;
        // lips: sealed at jaw 0, a wide horn at jaw 1; rounding narrows them
        let lip = a_or * js_max(0.0, jaw - 0.03) * gape * (1.0 - 0.8 * round);
        for i in 0..or.n {
            let u = (i as f64 + 0.5) / or.n as f64;
            let s = split + u * (1.0 - split);
            // the jaw hinges at the back: its opening grows toward the front
            let wedge = 1.0 + (0.25 + (gape - 1.0) * jaw - 0.45 * (1.0 - jaw)) * smoothstep(0.15, 1.0, u);
            let body_a = a_or * wedge * tongue(s);
            let w = smoothstep(0.78, 0.97, u);
            a.oral_area[i] = js_max(0.0, body_a * (1.0 - w) + lip * w);
        }
        a.net.set_tube_targets(or, &a.oral_area, Some(l_or), None);
        if let Some(velum) = a.velum {
            // an open mouth pulls the velum up a little; a sealed mouth needs the nose
            let v = velum_for(jaw);
            a.net.set_port_target(velum, b[B_VELUM_AREA] * v);
        }
        if let Some(na) = a.nasal {
            for i in 0..na.n {
                let u = (i as f64 + 0.5) / na.n as f64;
                // turbinates narrow the middle; the nostrils are small
                let shape = 1.0 - 0.35 * exp(-((u - 0.55) / 0.2) * ((u - 0.55) / 0.2));
                let nostril = 1.0 - 0.6 * smoothstep(0.85, 1.0, u);
                self.nasal_area[i] = b[B_NASAL_AREA] * shape * nostril;
            }
            a.net.set_tube_targets(na, &self.nasal_area, None, None);
        }

        // turbulence: aspiration at the glottis always (it scales with the flow's Reynolds number,
        // so it is quiet unless the folds are apart), and at the mouth's narrowest point for hisses
        let size = sqrt(b[B_ORAL_AREA] / 3.6);
        // EMPIRICAL size compensation: small tracts pass little flow, so their Reynolds numbers (and the
        // noise) are far lower for the same gesture; a kitten's hiss would otherwise be inaudible
        let small = 1.0 / js_max(0.02, size * size * size);
        let asp = ASPIRATION * (1.0 + 10.0 * breath) * small;
        let mut list = [NoiseSpec::new(a.glottis, a.pharynx.branch(1.min(a.pharynx.n - 2)), a.trachea.branch(a.trachea.n - 2), asp).band(5500.0, 300.0); 2];
        let mut len = 1;
        let hiss = clamp(f[F_HISS], 0.0, 1.0);
        if hiss > 0.001 {
            let mut mi = 0usize;
            let mut mv = f64::INFINITY;
            for i in 0..or.n - 1 {
                let v = a.oral_area[i];
                if v > 0.0 && v < mv {
                    mv = v;
                    mi = i;
                }
            }
            list[1] = NoiseSpec::new(or.branch(mi), or.branch((or.n - 2).min(mi + 1)), or.branch(mi.saturating_sub(1)), 6.0e-6 * hiss * small).band(9000.0, 1200.0);
            len = 2;
        }
        a.net.set_noise_sources(&list[..len]);
    }

    fn src_voicing(&self) -> f64 {
        self.fold_mix * self.folds.voicing + (1.0 - self.fold_mix) * self.a.glottis_src.voicing
    }
    fn src_f0(&self) -> f64 {
        if self.fold_mix > 0.5 { self.folds.f0 } else { self.a.glottis_src.f0_now }
    }
    fn src_phase(&self) -> f64 {
        if self.fold_mix > 0.5 { self.folds.cycle_phase() } else { self.a.glottis_src.cycle_phase() }
    }
    fn src_area(&self) -> f64 {
        self.fold_mix * self.folds.area + (1.0 - self.fold_mix) * self.a.glottis_src.area
    }

    #[inline]
    fn sample(&mut self) -> f64 {
        let a = &mut self.a;
        let p = &a.net.p;
        // |Δp|: the folds are sucked into vibration by flow in either direction (a purr sounds on
        // the in-breath too)
        let (ps, pv) = (p[a.trachea.last_node()], p[a.pharynx.first_node()]);
        let w = self.fold_mix;
        let mut area = 0.0;
        if w < 0.999 {
            area += (1.0 - w) * a.glottis_src.next((ps - pv).abs());
        }
        if w > 0.001 {
            area += w * self.folds.step(ps, pv);
        }
        // Breath noise. The network's own turbulence source only wakes above a critical Reynolds
        // number, which a pet-sized glottis rarely reaches, so the renders came out far cleaner
        // than any real meow or bark. Here the opening itself flutters (band-limited noise,
        // proportional to the opening): the noise rides on the flow, so it pulses with the folds
        // and stops when they shut, as aspiration noise does.
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        let white = (self.rng as f64 / 4294967295.0) * 2.0 - 1.0;
        self.flutter_lp += (white - self.flutter_lp) * self.flutter_coef;
        area *= 1.0 + self.flutter * self.flutter_lp;
        a.net.set_port_area(a.glottis, if area > 0.0 { area } else { 0.0 });
        a.net.step()
    }
}

pub struct PetVoice {
    pub fs_out: f64,
    fs: f64,
    m: usize,
    sim: Sim,
    pending_body: Option<[f64; N_BODY]>,
    economy: bool,
    /// fade for body swaps and stops
    swap_fade: f64,
    live: [f64; N_FRAME],
    live_gate: f64,
    target: [f64; N_FRAME],
    value: [f64; N_FRAME],
    gate: f64,
    track: Vec<f64>,
    track_keys: usize,
    track_t: f64,
    track_on: bool,
    track_loop: bool,
    track_gate: f64,
    pub clock: f64,
    dec: Decimator,
    ctrl_every: usize,
    ctrl_counter: i64,
    dc_x: f64,
    dc_y: f64,
    dc_coef: f64,
    mic_lp: f64,
    mic_lp2: f64,
    mic_coef: f64,
    room: Room,
    pub level: f64,
    level_sm: f64,
    level_coef: f64,
    /// output leveller (envelope follower state)
    env: f64,
    env_att: f64,
    env_rel: f64,
    // interval measures
    out_acc: f64,
    out_count: u64,
    glot_acc: f64,
    flow_acc: f64,
    rms_acc: [Vec<f64>; 3],
    mean_acc: [Vec<f64>; 3],
    rms_count: u64,
    sub: u32,
}

impl PetVoice {
    /// Oversampling factor for a body. The airway runs near 96 kHz whatever the device rate (a
    /// cat's tract is a few cm, and a section cannot be shorter than c/fs), but a long tract has
    /// sections to spare at half that, for a quarter of the work.
    fn oversample(fs_out: f64, body: &[f64; N_BODY], economy: bool) -> usize {
        let long = body[B_PHARYNX_LEN] + body[B_ORAL_LEN] >= 12.0;
        let target = if long || economy { 48000.0 } else { 96000.0 };
        clamp((target / fs_out).round(), 1.0, 8.0) as usize
    }

    pub fn new(fs_out: f64) -> PetVoice {
        let body = default_body();
        let m = Self::oversample(fs_out, &body, false);
        let fs = fs_out * m as f64;
        let sim = Sim::new(fs, &body);
        let mut v = PetVoice {
            fs_out,
            fs,
            m,
            sim,
            pending_body: None,
            economy: false,
            swap_fade: 1.0,
            live: rest_frame(),
            live_gate: 0.0,
            target: rest_frame(),
            value: rest_frame(),
            gate: 0.0,
            track: Vec::new(),
            track_keys: 0,
            track_t: 0.0,
            track_on: false,
            track_loop: false,
            track_gate: 0.0,
            clock: 0.0,
            dec: Decimator::new(m),
            ctrl_every: 64 * m,
            ctrl_counter: 0,
            dc_x: 0.0,
            dc_y: 0.0,
            dc_coef: exp((-2.0 * PI * 20.0) / fs_out),
            mic_lp: 0.0,
            mic_lp2: 0.0,
            mic_coef: 1.0 - exp((-2.0 * PI * MIC_LOWPASS_HZ) / fs_out),
            room: Room::new(fs_out),
            level: 1.0,
            level_sm: 1.0,
            env: 0.0,
            env_att: 1.0 - exp(-1.0 / (0.004 * fs_out)),
            env_rel: 1.0 - exp(-1.0 / (0.18 * fs_out)),
            level_coef: 1.0 - exp(-1.0 / (0.01 * fs_out)),
            out_acc: 0.0,
            out_count: 0,
            glot_acc: 0.0,
            flow_acc: 0.0,
            rms_acc: [vec![0.0; MAX_TUBE_N], vec![0.0; MAX_TUBE_N], vec![0.0; MAX_TUBE_N]],
            mean_acc: [vec![0.0; MAX_TUBE_N], vec![0.0; MAX_TUBE_N], vec![0.0; MAX_TUBE_N]],
            rms_count: 0,
            sub: 0,
        };
        v.init_sim();
        v
    }

    fn init_sim(&mut self) {
        let dt = self.ctrl_every as f64 / self.fs;
        self.sim.control(&self.value, 0.0, dt);
        self.sim.a.net.snap_to_targets();
        let tract = self.sim.body[B_PHARYNX_LEN] + self.sim.body[B_ORAL_LEN];
        let corner = clamp(MIC_LOWPASS_HZ * sqrt(MIC_REF_TRACT / tract), 1800.0, 5500.0);
        self.mic_coef = 1.0 - exp((-2.0 * PI * corner) / self.fs_out);
        for a in self.rms_acc.iter_mut().chain(self.mean_acc.iter_mut()) {
            a.fill(0.0);
        }
        self.rms_count = 0;
    }

    /// New anatomy. Takes effect at the next control step if silent, else after a ~12 ms fade.
    pub fn set_body(&mut self, body: &[f64; N_BODY]) {
        let mut b = *body;
        let d = default_body();
        for i in 0..N_BODY {
            if !b[i].is_finite() || b[i] <= 0.0 {
                b[i] = d[i];
            }
        }
        // keep the network a sane size whatever the caller sends
        for i in [B_TRACHEA_LEN, B_PHARYNX_LEN, B_ORAL_LEN, B_NASAL_LEN] {
            b[i] = clamp(b[i], 1.2, 45.0);
        }
        for i in [B_TRACHEA_AREA, B_PHARYNX_AREA, B_ORAL_AREA, B_NASAL_AREA] {
            b[i] = clamp(b[i], 0.03, 30.0);
        }
        b[B_FOLD_AREA] = clamp(b[B_FOLD_AREA], 0.002, 1.0);
        b[B_THRESHOLD] = clamp(b[B_THRESHOLD], 0.3, 8.0);
        b[B_WALL_RADIATION] = clamp(b[B_WALL_RADIATION], 0.0, 1.0);
        b[B_GAPE] = clamp(b[B_GAPE], 0.5, 4.0);
        if b == self.sim.body {
            self.pending_body = None;
            return;
        }
        self.pending_body = Some(b);
    }

    /// Economy: run short tracts at 48 kHz too (a quarter of the work, coarser sections), for
    /// devices that cannot keep up. Takes effect through a body swap.
    pub fn set_economy(&mut self, on: bool) {
        if on != self.economy {
            self.economy = on;
            self.pending_body = Some(self.pending_body.unwrap_or(self.sim.body));
        }
    }

    pub fn body(&self) -> &[f64; N_BODY] {
        &self.sim.body
    }

    pub fn set_live(&mut self, frame: &[f64; N_FRAME], gate: f64) {
        for i in 0..N_FRAME {
            if frame[i].is_finite() {
                self.live[i] = frame[i];
            }
        }
        self.live_gate = clamp(gate, 0.0, 1.5);
    }

    /// Scratch for a track of `keys` keys (each KEY_SIZE f64: time, then a frame). Fill it, then
    /// call [`play_track`](Self::play_track).
    pub fn track_buffer(&mut self, keys: usize) -> &mut [f64] {
        let n = keys.min(20000) * KEY_SIZE;
        if self.track.len() < n {
            self.track.resize(n, 0.0);
        }
        &mut self.track[..n]
    }

    pub fn play_track(&mut self, keys: usize, looped: bool) {
        self.track_keys = keys.min(self.track.len() / KEY_SIZE);
        self.track_t = 0.0;
        self.track_on = self.track_keys > 0;
        self.track_loop = looped;
    }

    pub fn stop_track(&mut self) {
        self.track_on = false;
        self.track_gate = 0.0;
    }

    pub fn track_time(&self) -> f64 {
        if self.track_on { self.track_t } else { -1.0 }
    }

    fn eval_track(&mut self, dt: f64) {
        if !self.track_on {
            self.target = self.live;
            self.track_gate = 0.0;
            return;
        }
        let n = self.track_keys;
        let end = self.track[(n - 1) * KEY_SIZE];
        if self.track_t > end {
            if self.track_loop && end > 0.0 {
                self.track_t -= end;
            } else {
                self.stop_track();
                self.target = self.live;
                return;
            }
        }
        let t = self.track_t;
        // keys are time-ordered; tracks are short, so a scan is fine at control rate
        let mut i = 0;
        while i + 1 < n && self.track[(i + 1) * KEY_SIZE] <= t {
            i += 1;
        }
        let k0 = &self.track[i * KEY_SIZE..(i + 1) * KEY_SIZE];
        if i + 1 < n {
            let k1 = &self.track[(i + 1) * KEY_SIZE..(i + 2) * KEY_SIZE];
            let u = clamp((t - k0[0]) / js_max(1e-6, k1[0] - k0[0]), 0.0, 1.0);
            for j in 0..N_FRAME {
                let (x0, x1) = (k0[1 + j], k1[1 + j]);
                // pitch moves in log frequency
                self.target[j] = if j == F_F0 && x0 > 0.0 && x1 > 0.0 { x0 * pow(x1 / x0, u) } else { x0 + (x1 - x0) * u };
            }
        } else {
            self.target.copy_from_slice(&k0[1..]);
        }
        self.track_gate = 1.0;
        self.track_t += dt;
    }

    fn control(&mut self) {
        let dt = self.ctrl_every as f64 / self.fs;
        // a pending body swaps in once the fade is down
        if self.pending_body.is_some() {
            self.swap_fade -= dt / 0.012;
            if self.swap_fade <= 0.0 || (self.gate < 0.01 && self.out_quiet()) {
                let b = self.pending_body.take().unwrap();
                let m = Self::oversample(self.fs_out, &b, self.economy);
                if m != self.m {
                    self.m = m;
                    self.fs = self.fs_out * m as f64;
                    self.dec = Decimator::new(m);
                    self.ctrl_every = 64 * m;
                }
                self.sim = Sim::new(self.fs, &b);
                self.init_sim();
                self.swap_fade = 0.0;
            }
        } else if self.swap_fade < 1.0 {
            self.swap_fade = js_min(1.0, self.swap_fade + dt / 0.012);
        }
        self.eval_track(dt);
        for i in 0..N_FRAME {
            let a = 1.0 - exp(-dt / SMOOTH[i]);
            let (cur, tgt) = (self.value[i], self.target[i]);
            self.value[i] = if i == F_F0 && cur > 0.0 && tgt > 0.0 { cur * pow(tgt / cur, a) } else { cur + (tgt - cur) * a };
        }
        let goal = js_max(self.live_gate, self.track_gate);
        let tau = if goal > self.gate { 0.006 } else { 0.035 };
        self.gate += (goal - self.gate) * (1.0 - exp(-dt / tau));
        self.sim.control(&self.value, self.gate, dt);
        self.sim.a.net.begin_block(self.ctrl_every);
        self.ctrl_counter = self.ctrl_every as i64;
        self.clock += dt;
    }

    fn out_quiet(&self) -> bool {
        self.dc_y.abs() < 1e-4
    }

    pub fn render(&mut self, out: &mut [f32]) {
        for o in out.iter_mut() {
            // one output sample: step the airway until the decimator delivers (a body swap inside
            // control() may change the oversampling factor)
            loop {
                if self.ctrl_counter <= 0 {
                    self.control();
                }
                self.ctrl_counter -= 1;
                let y = self.sim.sample();
                self.sub = self.sub.wrapping_add(1);
                if self.sub & 7 == 0 {
                    let a = &self.sim.a;
                    let p = &a.net.p;
                    let tubes = [Some(a.pharynx), Some(a.oral), a.nasal];
                    for (ti, t) in tubes.iter().enumerate() {
                        let Some(t) = t else { continue };
                        let n = t.n.min(MAX_TUBE_N);
                        let (acc, mean) = (&mut self.rms_acc[ti], &mut self.mean_acc[ti]);
                        for k in 0..n {
                            let v = p[t.first + k];
                            acc[k] += v * v;
                            mean[k] += v;
                        }
                    }
                    self.glot_acc += self.sim.src_area();
                    self.flow_acc += a.net.u[a.glottis];
                    self.rms_count += 1;
                }
                if self.dec.push(y) {
                    // the level glides (~10 ms) so a change while sounding does not click
                    self.level_sm += (self.level - self.level_sm) * self.level_coef;
                    let mut v = self.dec.value * self.sim.body[B_GAIN] * 6.4e-8 * self.swap_fade;
                    let hp = v - self.dc_x + self.dc_coef * self.dc_y;
                    self.dc_x = v;
                    self.dc_y = hp;
                    // two poles: about −6 dB at the corner, −12 dB per octave above it
                    self.mic_lp += (hp - self.mic_lp) * self.mic_coef;
                    self.mic_lp2 += (self.mic_lp - self.mic_lp2) * self.mic_coef;
                    v = self.mic_lp2;
                    // Leveller, as a phone's microphone does: 3:1 above −34 dBFS with make-up, so a
                    // purr or a sad mew is audible next to a bark. Dynamics only; the level knob
                    // comes after it, so "louder" stays louder.
                    let a0 = v.abs();
                    let coef = if a0 > self.env { self.env_att } else { self.env_rel };
                    self.env += (a0 - self.env) * coef;
                    if self.env > COMP_THRESHOLD {
                        v *= pow(self.env / COMP_THRESHOLD, 1.0 / COMP_RATIO - 1.0);
                    }
                    v *= COMP_MAKEUP * self.level_sm;
                    v += ROOM_MIX * self.room.step(v);
                    let av = v.abs();
                    if av > 0.7 {
                        v = v.signum() * (0.7 + 0.3 * tanh((av - 0.7) / 0.3));
                    }
                    if !v.is_finite() {
                        // a blown-up airway (should not happen): rebuild it rather than stay silent
                        v = 0.0;
                        let b = self.sim.body;
                        self.sim = Sim::new(self.fs, &b);
                        self.init_sim();
                        self.dc_x = 0.0;
                        self.dc_y = 0.0;
                    }
                    *o = v as f32;
                    self.out_acc += v * v;
                    self.out_count += 1;
                    break;
                }
            }
        }
    }

    /// Fill `out` (≥ TELE_MAX) and reset the interval measures. Returns the length written.
    pub fn telemetry(&mut self, out: &mut [f32]) -> usize {
        let a = &self.sim.a;
        let c = js_max(1.0, self.rms_count as f64);
        let tubes: [Option<Tube>; 3] = [Some(a.pharynx), Some(a.oral), a.nasal];
        let n = |i: usize| tubes[i].map_or(0, |t| t.n.min(MAX_TUBE_N));
        out[T_CLOCK] = self.clock as f32;
        out[T_TRACK_TIME] = self.track_time() as f32;
        out[T_OUT_RMS] = sqrt(self.out_acc / js_max(1.0, self.out_count as f64)) as f32;
        out[T_GLOTTIS] = (self.glot_acc / c) as f32;
        out[T_VOICING] = self.sim.src_voicing() as f32;
        out[T_F0] = self.sim.src_f0() as f32;
        out[T_VELUM] = (self.sim.body[B_VELUM_AREA] * velum_for(clamp(self.value[F_JAW], 0.0, 1.0))) as f32;
        out[T_N_PH] = n(0) as f32;
        out[T_N_OR] = n(1) as f32;
        out[T_N_NA] = n(2) as f32;
        out[T_LEN_PH] = a.net.tube_length[a.pharynx.index] as f32;
        out[T_LEN_OR] = a.net.tube_length[a.oral.index] as f32;
        out[T_LEN_NA] = a.nasal.map_or(0.0, |t| a.net.tube_length[t.index]) as f32;
        out[T_GATE] = self.gate as f32;
        out[T_FOLD_PHASE] = self.sim.src_phase() as f32;
        out[T_FLOW] = (self.flow_acc / c) as f32;
        for i in 0..N_FRAME {
            out[T_FRAME + i] = self.value[i] as f32;
        }
        let mut w = T_HEADER;
        for (ti, t) in tubes.iter().enumerate() {
            let Some(t) = t else { continue };
            for k in 0..n(ti) {
                out[w] = a.net.area[t.first + k] as f32;
                w += 1;
            }
        }
        for (ti, _) in tubes.iter().enumerate() {
            for k in 0..n(ti) {
                let mean = self.mean_acc[ti][k] / c;
                out[w] = sqrt(js_max(0.0, self.rms_acc[ti][k] / c - mean * mean)) as f32;
                w += 1;
            }
            self.rms_acc[ti].fill(0.0);
            self.mean_acc[ti].fill(0.0);
        }
        self.rms_count = 0;
        self.out_acc = 0.0;
        self.out_count = 0;
        self.glot_acc = 0.0;
        self.flow_acc = 0.0;
        w
    }
}
