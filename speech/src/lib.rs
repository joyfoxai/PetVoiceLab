//! English text → speech with CHIMERA's own human voice (vendor/chimera: G2P, phrase planner with
//! statement/question intonation, the articulatory voice). This is the "person" for PetVoice
//! Lab's typed input: the sentence is rendered here, then analysed like any recording.
//!
//! Kept out of the pet engine's wasm (it pulls in the phonetics tables); only a Worker loads it.
//! C ABI, no imports. Single-threaded use: one global state.

use chimera::anatomy::human::{BODY_CHILD, BODY_FEMALE, BODY_MALE};
use chimera::phonetics::english::EnglishG2P;
use chimera::phonetics::planner::{PhraseInput, PlanOptions, plan_phrases};
use chimera::voice::human_voice::{HumanVoice, SourcePatch};
use std::cell::RefCell;

pub const FS: f64 = 48000.0;
/// longest render, seconds
pub const MAX_SECONDS: f64 = 14.0;

struct State {
    g2p: EnglishG2P,
    out: Vec<f32>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        if s.is_none() {
            chimera::init();
            *s = Some(State { g2p: EnglishG2P::new(), out: Vec::new() });
        }
        f(s.as_mut().unwrap())
    })
}

/// Allocate `n` bytes for JavaScript to write text into; free with `sp_free(ptr, n)`.
#[unsafe(no_mangle)]
pub extern "C" fn sp_alloc(n: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; n.max(1)].into_boxed_slice()) as *mut u8
}

/// # Safety
/// `p`, `n` from one `sp_alloc` call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sp_free(p: *mut u8, n: usize) {
    if !p.is_null() {
        drop(unsafe { Box::from_raw(core::ptr::slice_from_raw_parts_mut(p, n.max(1))) });
    }
}

/// Load the CMU Pronouncing Dictionary (UTF-8 text, "word<TAB>PH ON EMES" per line). Without it
/// words are pronounced by letter-to-sound rules. Returns 1 when loaded.
/// # Safety
/// `p..p+n` must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sp_load_dict(p: *const u8, n: usize) -> u32 {
    let bytes = unsafe { core::slice::from_raw_parts(p, n) };
    let Ok(text) = core::str::from_utf8(bytes) else { return 0 };
    with(|s| {
        s.g2p.load_dict(text);
        s.g2p.is_loaded() as u32
    })
}

/// The pitch each body speaks at (as CHIMERA's CLI).
fn body_f0(body: u32) -> f64 {
    match body {
        1 => 205.0,
        2 => 250.0,
        _ => 112.0,
    }
}

pub fn say(text: &str, body: u32, rate: f64) -> Vec<f32> {
    with(|s| {
        say_into(s, text, body, rate);
        s.out.clone()
    })
}

fn say_into(s: &mut State, text: &str, body: u32, rate: f64) {
    let (b, name) = match body {
        1 => (BODY_FEMALE, "female"),
        2 => (BODY_CHILD, "child"),
        _ => (BODY_MALE, "male"),
    };
    let f0 = body_f0(body);
    let phrases = s.g2p.to_phrases(text);
    let inputs: Vec<PhraseInput> = phrases.iter().map(|p| PhraseInput { segments: p.segments.clone(), intonation: Some(p.intonation), pause: Some(p.pause) }).collect();
    s.out.clear();
    if inputs.iter().all(|p| p.segments.is_empty()) {
        return;
    }
    let mut voice = HumanVoice::new(FS, b, 2);
    voice.set_source(&SourcePatch::f0(f0));
    let rate = if rate.is_finite() { rate.clamp(0.5, 2.0) } else { 1.0 };
    let plan = plan_phrases(&inputs, &PlanOptions { body: name.into(), t0: 0.05, f0: Some(f0), rate: Some(rate), ..Default::default() });
    voice.schedule(&plan.gestures);
    let total = ((plan.end + 0.3).min(MAX_SECONDS) * FS) as usize;
    s.out.resize(total, 0.0);
    for block in s.out.chunks_mut(128) {
        voice.render(block);
    }
}

/// Speak UTF-8 `text` with body 0 male, 1 female, 2 child at `rate` (1 = normal). Returns the
/// number of 48 kHz mono samples waiting at `sp_out_ptr()` (0: nothing pronounceable).
/// # Safety
/// `p..p+n` must be readable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sp_say(p: *const u8, n: usize, body: u32, rate: f64) -> u32 {
    let bytes = unsafe { core::slice::from_raw_parts(p, n) };
    let Ok(text) = core::str::from_utf8(bytes) else { return 0 };
    with(|s| {
        say_into(s, text, body, rate);
        s.out.len() as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn sp_out_ptr() -> *const f32 {
    with(|s| s.out.as_ptr())
}

#[cfg(test)]
mod tests {
    #[test]
    fn speaks_without_a_dictionary_and_ignores_unpronounceable_text() {
        let y = super::say("Good dog. Do you want a treat?", 1, 1.0);
        assert!(y.len() > 48000 && y.iter().all(|v| v.is_finite()));
        let rms = (y.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / y.len() as f64).sqrt();
        assert!(rms > 1e-3, "rms {rms}");
        assert!(super::say("。。。", 1, 1.0).is_empty());
    }
}
