/**
 * Prosody straight from typed text, by rule, for text there is no voice for (Chinese; anything
 * with Chinese in it). No speech is synthesised: this writes the tune a sentence of that length
 * and punctuation would roughly have, in the same `Prosody` form the analyser produces, so the
 * rest of the pipeline (pitch mapping, mouth gestures, the chart) is shared.
 *
 * EMPIRICAL and deliberately simple: one syllable per Chinese character, a pitch that drifts down
 * through each phrase, a fall at 。 a rise at ？ a higher, harder delivery at ！. It knows nothing
 * of the four tones, of stress, or of what the words mean.
 */
import type { Prosody, Syllable } from "../analysis/prosody.ts";

const HOP = 0.01;
const BASE_HZ = 200;

type Ending = "statement" | "question" | "exclaim";
interface Unit {
  /** seconds */
  dur: number;
  /** a light syllable (a sentence-final particle, an unstressed English syllable) */
  light: boolean;
}
interface Phrase {
  units: Unit[];
  ending: Ending;
  /** pause after it, seconds */
  pause: number;
}

const isCjk = (ch: string) => /[㐀-鿿豈-﫿]/.test(ch);
export const hasCjk = (text: string) => /[㐀-鿿豈-﫿]/.test(text);

function englishSyllables(word: string): number {
  const groups = word.toLowerCase().replace(/e\b/, "").match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

function parse(text: string): Phrase[] {
  const phrases: Phrase[] = [];
  let units: Unit[] = [];
  let lastChar = "";
  const close = (ending: Ending, pause: number) => {
    if (units.length) phrases.push({ units, ending, pause });
    units = [];
  };
  let total = 0;
  for (let i = 0; i < text.length && total < 60; i++) {
    const ch = text[i];
    if (isCjk(ch)) {
      const particle = "的了吗呢吧啊呀嘛么哦哇啦".includes(ch);
      units.push({ dur: particle ? 0.16 : 0.21, light: particle });
      lastChar = ch;
      total++;
    } else if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z']/.test(text[j])) j++;
      const n = englishSyllables(text.slice(i, j));
      for (let k = 0; k < n; k++) units.push({ dur: 0.17, light: k > 0 });
      total += n;
      lastChar = "";
      i = j - 1;
    } else if (/[0-9]/.test(ch)) {
      units.push({ dur: 0.2, light: false });
      total++;
    } else if ("？?".includes(ch)) close("question", 0.4);
    else if ("！!".includes(ch)) close("exclaim", 0.4);
    else if ("。.；;…\n".includes(ch)) close("statement", 0.4);
    else if ("，,、：:—-".includes(ch)) {
      // a comma: a short breath, the phrase before it hangs (neither falls nor rises much)
      if (units.length) phrases.push({ units, ending: "statement", pause: 0.18 });
      units = [];
    }
  }
  // no closing punctuation: 吗 / 么 / 呢 at the end still asks
  close("吗么呢".includes(lastChar) ? "question" : "statement", 0.2);
  return phrases;
}

/** Text → a rule-made prosody, or null when there is nothing to say. */
export function textToProsody(text: string): Prosody | null {
  const phrases = parse(text.trim());
  if (!phrases.length) return null;
  const f0: number[] = [];
  const energy: number[] = [];
  const active: number[] = [];
  const syllables: Syllable[] = [];
  const silence = (sec: number) => {
    for (let i = 0; i < Math.round(sec / HOP); i++) {
      f0.push(0);
      energy.push(0);
      active.push(0);
    }
  };
  silence(0.1);
  phrases.forEach((ph, pi) => {
    const n = ph.units.length;
    const lift = ph.ending === "exclaim" ? 2.5 : 0;
    const loud = ph.ending === "exclaim" ? 1 : 0.8;
    ph.units.forEach((u, ui) => {
      const last = ui === n - 1;
      const dur = u.dur * (last ? 1.45 : 1);
      const frames = Math.max(4, Math.round(dur / HOP));
      const t0 = f0.length * HOP;
      // declination: +1.5 → −1.5 semitones through the phrase; every other full syllable leans up
      const pos = n > 1 ? ui / (n - 1) : 0.5;
      const base = lift + 1.5 - 3 * pos + (!u.light && ui % 2 === 0 ? 0.9 : 0) - (u.light ? 0.8 : 0);
      let peakAt = 0;
      let peakE = 0;
      for (let k = 0; k < frames; k++) {
        const x = (k + 0.5) / frames;
        let st = base + 0.7 * Math.sin(Math.PI * x);
        if (last) {
          // the phrase's last syllable carries its ending
          if (ph.ending === "question") st += 2 + 7 * x;
          else if (ph.ending === "exclaim") st += 1.5 - 6.5 * x;
          else st -= (ph.pause < 0.3 ? 1.2 : 4.5) * x;
        } else if (ph.ending === "question" && ui === n - 2) st += 2 * x;
        const e = loud * (u.light ? 0.7 : 1) * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, x * 1.15))) * (last ? 1 - 0.5 * x * x : 1);
        f0.push(BASE_HZ * Math.pow(2, st / 12));
        energy.push(Math.min(1, e));
        active.push(1);
        if (e > peakE) {
          peakE = e;
          peakAt = k;
        }
      }
      syllables.push({ t0, t1: t0 + frames * HOP, peak: t0 + peakAt * HOP, level: Math.min(1, peakE) });
    });
    silence(pi === phrases.length - 1 ? 0.12 : ph.pause);
  });
  const voiced = f0.filter((v) => v > 0).sort((a, b) => a - b);
  return {
    hop: HOP,
    duration: f0.length * HOP,
    f0: Float32Array.from(f0),
    energy: Float32Array.from(energy),
    active: Uint8Array.from(active),
    syllables,
    medianF0: voiced[voiced.length >> 1] ?? BASE_HZ,
  };
}
