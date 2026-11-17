//! PetVoice Lab's sounding layer, as a C ABI for the browser. No wasm-bindgen and no imports
//! (an AudioWorkletGlobalScope has no fetch or TextDecoder): numbers and pointers only, the same
//! boundary style as CHIMERA's own `chimera-wasm` crate.
//!
//! One handle is one voice. Buffers it owns keep their address for its lifetime, but JavaScript
//! must re-create typed-array views if `memory.buffer` changes (a body swap or a long track can
//! grow memory).

pub mod folds;
pub mod pet;

use pet::{KEY_SIZE, N_BODY, N_FRAME, PetVoice, TELE_MAX};

/// Largest `pv_render` request (frames).
pub const MAX_RENDER: usize = 4096;

pub struct Handle {
    voice: PetVoice,
    out: Vec<f32>,
    body: [f64; N_BODY],
    frame: [f64; N_FRAME],
    tele: Vec<f32>,
}

#[unsafe(no_mangle)]
pub extern "C" fn pv_new(fs_out: f64) -> *mut Handle {
    let fs = if fs_out.is_finite() && fs_out >= 8000.0 { fs_out } else { 48000.0 };
    Box::into_raw(Box::new(Handle { voice: PetVoice::new(fs), out: vec![0.0; MAX_RENDER], body: pet::default_body(), frame: pet::rest_frame(), tele: vec![0.0; TELE_MAX] }))
}

/// # Safety
/// `h` must come from `pv_new` and not be used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pv_free(h: *mut Handle) {
    if !h.is_null() {
        drop(unsafe { Box::from_raw(h) });
    }
}

macro_rules! h {
    ($h:expr) => {
        unsafe { &mut *$h }
    };
}

#[unsafe(no_mangle)]
pub extern "C" fn pv_n_body() -> u32 {
    N_BODY as u32
}
#[unsafe(no_mangle)]
pub extern "C" fn pv_n_frame() -> u32 {
    N_FRAME as u32
}
#[unsafe(no_mangle)]
pub extern "C" fn pv_tele_header() -> u32 {
    pet::T_HEADER as u32
}

/// Scratch for a body (N_BODY f64). Write it, then `pv_apply_body`.
/// # Safety
/// `h` must be a live handle (as for every function below).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pv_body_ptr(h: *mut Handle) -> *mut f64 {
    h!(h).body.as_mut_ptr()
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pv_apply_body(h: *mut Handle) {
    let h = h!(h);
    h.voice.set_body(&h.body);
}

/// Scratch for a frame (N_FRAME f64). Write it, then `pv_set_live`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pv_frame_ptr(h: *mut Handle) -> *mut f64 {
    h!(h).frame.as_mut_ptr()
}
/// Hold the scratch frame as the live state; `gate` 0..1 is the breath gate.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pv_set_live(h: *mut Handle, gate: f64) {
    let h = h!(h);
    h.voice.set_live(&h.frame, gate);
}

/// Scratch for a track of `keys` keys (KEY_SIZE f64 each). Write it, then `pv_play_track`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pv_track_ptr(h: *mut Handle, keys: u32) -> *mut f64 {
    h!(h).voice.track_buffer(keys as usize).as_mut_ptr()
}
#[unsafe(no_mangle)]
pub extern "C" fn pv_key_size() -> u32 {
    KEY_SIZE as u32
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pv_play_track(h: *mut Handle, keys: u32, looped: u32) {
    h!(h).voice.play_track(keys as usize, looped != 0);
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pv_stop_track(h: *mut Handle) {
    h!(h).voice.stop_track();
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pv_set_level(h: *mut Handle, level: f64) {
    h!(h).voice.level = if level.is_finite() { level.clamp(0.0, 8.0) } else { 1.0 };
}

/// Economy mode (1/0): halve the internal rate for short tracts when the device cannot keep up.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pv_set_economy(h: *mut Handle, on: u32) {
    h!(h).voice.set_economy(on != 0);
}

/// Render `n` (≤ MAX_RENDER) mono frames; returns the output buffer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pv_render(h: *mut Handle, n: u32) -> *const f32 {
    let h = h!(h);
    let n = (n as usize).min(MAX_RENDER);
    h.voice.render(&mut h.out[..n]);
    h.out.as_ptr()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pv_tele_ptr(h: *mut Handle) -> *const f32 {
    h!(h).tele.as_ptr()
}
/// Fill the telemetry block (layout in pet.rs); returns its length in f32s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pv_telemetry(h: *mut Handle) -> u32 {
    let h = h!(h);
    h.voice.telemetry(&mut h.tele) as u32
}

#[cfg(test)]
mod tests {
    use super::pet::*;

    fn render(v: &mut PetVoice, secs: f64) -> Vec<f32> {
        let mut out = vec![0.0f32; (secs * v.fs_out) as usize];
        for c in out.chunks_mut(128) {
            v.render(c);
        }
        out
    }
    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64).sqrt()
    }
    fn meow_frame() -> [f64; N_FRAME] {
        let mut f = rest_frame();
        f[F_F0] = 600.0;
        f[F_PRESSURE] = 8.0;
        f[F_JAW] = 0.6;
        f
    }

    #[test]
    fn silent_at_rest_and_sounds_when_blown() {
        let mut v = PetVoice::new(48000.0);
        assert!(rms(&render(&mut v, 0.1)) < 1e-5);
        v.set_live(&meow_frame(), 1.0);
        let y = render(&mut v, 0.3);
        let r = rms(&y[4800..]);
        assert!(r > 1e-3 && r.is_finite(), "rms {r}");
    }

    #[test]
    fn sealed_lips_hum_through_the_nose() {
        // the velum follows the lips: with the mouth shut the voice leaves by the nostrils,
        // quieter and duller, but it does not stop
        let mut v = PetVoice::new(48000.0);
        let mut f = meow_frame();
        v.set_live(&f, 1.0);
        let open = rms(&render(&mut v, 0.3)[4800..]);
        f[F_JAW] = 0.0;
        v.set_live(&f, 1.0);
        let shut = rms(&render(&mut v, 0.3)[4800..]);
        assert!(shut > open * 0.02 && shut < open * 0.9, "open {open} shut {shut}");
    }

    #[test]
    fn holds_at_any_device_rate_and_any_body() {
        for fs in [16000.0, 22050.0, 44100.0, 48000.0, 96000.0] {
            for scale in [0.5, 1.0, 3.5] {
                let mut v = PetVoice::new(fs);
                let mut b = default_body();
                for i in [B_TRACHEA_LEN, B_PHARYNX_LEN, B_ORAL_LEN, B_NASAL_LEN] {
                    b[i] *= scale;
                }
                for i in [B_TRACHEA_AREA, B_PHARYNX_AREA, B_ORAL_AREA, B_NASAL_AREA, B_FOLD_AREA, B_VELUM_AREA] {
                    b[i] *= scale * scale;
                }
                v.set_body(&b);
                let mut f = meow_frame();
                f[F_ROUND] = 1.0;
                f[F_LARYNX] = 1.0;
                f[F_ROUGH] = 0.8;
                f[F_PRESSURE] = 25.0;
                v.set_live(&f, 1.0);
                let y = render(&mut v, 0.4);
                assert!(y.iter().all(|x| x.is_finite()));
                assert!(rms(&y[y.len() / 2..]) > 1e-4, "fs {fs} scale {scale}");
            }
        }
    }

    #[test]
    fn block_size_does_not_change_the_samples() {
        let run = |block: usize| {
            let mut v = PetVoice::new(48000.0);
            v.set_live(&meow_frame(), 1.0);
            let mut out = vec![0.0f32; 9600];
            for c in out.chunks_mut(block) {
                v.render(c);
            }
            out
        };
        assert_eq!(run(128), run(1000));
    }

    #[test]
    fn economy_mode_still_sounds() {
        let mut v = PetVoice::new(48000.0);
        v.set_live(&meow_frame(), 1.0);
        render(&mut v, 0.2);
        v.set_economy(true);
        let y = render(&mut v, 0.4);
        assert!(y.iter().all(|x| x.is_finite()));
        assert!(rms(&y[9600..]) > 1e-3);
    }

    #[test]
    fn a_track_plays_and_ends() {
        let mut v = PetVoice::new(48000.0);
        let f = meow_frame();
        let buf = v.track_buffer(2);
        buf[0] = 0.0;
        buf[1..KEY_SIZE].copy_from_slice(&f);
        buf[KEY_SIZE] = 0.2;
        buf[KEY_SIZE + 1..].copy_from_slice(&f);
        v.play_track(2, false);
        let y = render(&mut v, 0.6);
        assert!(rms(&y[4800..9600]) > 1e-3);
        assert!(rms(&y[24000..]) < 1e-4);
        assert!(v.track_time() < 0.0);
    }

    #[test]
    #[ignore]
    fn probe_folds() {
        let cat = [7.7998, 0.3359, 3.2595, 0.6997, 4.9508, 1.1132, 5.7904, 0.2569, 0.0336, 1.5105, 0.5000, 0.2056, 4.5330, 1.5000];
        let dog = [17.2900, 1.7516, 6.7431, 2.8026, 10.5469, 5.0885, 12.2854, 1.2296, 0.1518, 1.9645, 0.5000, 0.9837, 1.0397, 1.9000];
        let args: Vec<f64> = std::env::var("PROBE").unwrap_or_default().split(',').filter_map(|x| x.parse().ok()).collect();
        let _ = args;
        let mut go = |name: &str, body: &[f64; N_BODY], f0: f64, p: f64, ten: f64, br: f64, rough: f64| {
            let mut v = PetVoice::new(48000.0);
            v.set_body(body);
            let mut f = rest_frame();
            f[F_F0] = f0; f[F_PRESSURE] = p; f[F_JAW] = 0.6; f[F_TENSION] = ten; f[F_BREATH] = br; f[F_ROUGH] = rough;
            v.set_live(&f, 1.0);
            let y = render(&mut v, 0.6);
            let mut t = vec![0.0f32; TELE_MAX];
            v.telemetry(&mut t);
            let x: Vec<f64> = y[14400..].iter().map(|v| *v as f64).collect();
            // autocorrelation pitch and clarity
            let n = 4096;
            let e0: f64 = x[..n].iter().map(|v| v * v).sum();
            let (mut best, mut bl) = (0.0, 0);
            for lag in 20..960 {
                let mut c = 0.0; let mut e1 = 0.0;
                for i in 0..n { c += x[i] * x[i + lag]; e1 += x[i + lag] * x[i + lag]; }
                let r = c / (e0 * e1).sqrt().max(1e-12);
                if r > best + 0.02 { best = r; bl = lag; }
            }
            println!("{name} f0 {f0:5.0} P {p:4.1} ten {ten:.2} br {br:.2} rough {rough:.2} | tele f0 {:6.1} voi {:.2} glot {:.4} | acf f0 {:6.1} clarity {:.2} rms {:.3}", t[T_F0], t[T_VOICING], t[T_GLOTTIS], 48000.0 / bl.max(1) as f64, best, rms(&y[14400..]));
        };
        for br in [0.17, 0.3, 0.5, 0.7, 0.85, 0.95] { go("cat", &cat, 600.0, 7.8, 0.5, br, 0.04); }
        for p in [1.0, 2.0, 3.0, 5.0] { go("cat", &cat, 600.0, p, 0.4, 0.2, 0.04); }
        for p in [14.0, 25.0, 40.0] { for r in [0.3, 0.45, 0.6, 0.7, 0.8, 0.9, 1.0] { go("dog", &dog, 380.0, p, 0.8, 0.03, r); } }
    }
}
