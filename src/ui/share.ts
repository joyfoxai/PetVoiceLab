/** A pet in a URL fragment. */
import { DEFAULT_SPEC, MOODS, type Mood, type PetSpec } from "../params/pet.ts";

const hex = (t: string) => Array.from(new TextEncoder().encode(t), (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => new TextDecoder().decode(new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16))));

/**
 * `pet-cat-60-50-45-coax-90-e59ba2e5ad90`: species, size, age, snout (×100), mood, texture
 * (0..200 for −1..1), name as UTF-8 hex. Letters, digits and hyphens only, because some hosts
 * (an embedded page, a chat app's link preview) pass nothing else through a URL fragment.
 */
export function encodeSpec(s: PetSpec): string {
  const n = (x: number) => String(Math.round(x * 100));
  return ["pet", s.species, n(s.size), n(s.age), n(s.snout), s.mood, n(s.texture + 1), hex(s.name.slice(0, 12))].join("-");
}

export function decodeSpec(text: string): PetSpec | null {
  const p = text.split("-");
  if (p.length < 7 || p[0] !== "pet" || (p[1] !== "cat" && p[1] !== "dog")) return null;
  const num = (x: string, lo: number, hi: number, d: number) => {
    const v = Number(x) / 100;
    return x !== "" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  };
  let name = DEFAULT_SPEC.name;
  try {
    if (p[7] && /^([0-9a-f]{2})+$/.test(p[7])) name = unhex(p[7]).slice(0, 12) || name;
  } catch {
    /* keep the default */
  }
  return {
    species: p[1],
    name,
    size: num(p[2], 0, 1, 0.5),
    age: num(p[3], 0, 1, 0.5),
    snout: num(p[4], 0, 1, 0.5),
    mood: (MOODS as string[]).includes(p[5]) ? (p[5] as Mood) : "happy",
    texture: num(p[6], 0, 2, 1) - 1,
  };
}

export function shareUrl(s: PetSpec): string {
  const u = new URL(location.href);
  u.hash = encodeSpec(s);
  return u.toString();
}

export function specFromLocation(): PetSpec | null {
  return decodeSpec(location.hash.replace(/^#/, ""));
}
