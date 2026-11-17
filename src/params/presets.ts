import type { PetSpec } from "./pet.ts";

export interface Preset {
  id: string;
  label: string;
  note: string;
  /** coat for the pet's outside (a look only; see ui/cutaway.ts COATS) */
  coat: "orange" | "cream" | "black" | "grey" | "white" | "shiba" | "brown" | "tan";
  spec: PetSpec;
}

export const PRESETS: Preset[] = [
  { id: "kitten", coat: "cream", label: "小奶猫", note: "两个月大，短声道、细声带", spec: { species: "cat", name: "奶糖", size: 0.3, age: 0.06, snout: 0.3, mood: "coax", texture: -0.5 } },
  { id: "orange", coat: "orange", label: "成年橘猫", note: "中等体型，嗓门亮", spec: { species: "cat", name: "橘座", size: 0.6, age: 0.5, snout: 0.5, mood: "happy", texture: 0.0 } },
  { id: "tom", coat: "black", label: "老公猫", note: "大体型、上了年纪、沙哑", spec: { species: "cat", name: "老黑", size: 1.0, age: 0.95, snout: 0.55, mood: "angry", texture: 0.75 } },
  { id: "flat", coat: "grey", label: "扁脸猫", note: "大个头、短鼻、鼻腔窄，声音发闷", spec: { species: "cat", name: "加菲", size: 0.9, age: 0.62, snout: 0.0, mood: "sad", texture: 0.45 } },
  { id: "toy", coat: "white", label: "小型犬", note: "吉娃娃体型，声道 9 cm 出头", spec: { species: "dog", name: "豆豆", size: 0.05, age: 0.45, snout: 0.3, mood: "happy", texture: -0.4 } },
  { id: "mid", coat: "shiba", label: "中型犬", note: "柴犬体型", spec: { species: "dog", name: "阿柴", size: 0.45, age: 0.5, snout: 0.6, mood: "happy", texture: 0.0 } },
  { id: "big", coat: "brown", label: "大型犬", note: "大丹体型，声道 25 cm", spec: { species: "dog", name: "将军", size: 1.0, age: 0.6, snout: 0.8, mood: "angry", texture: 0.5 } },
  { id: "pup", coat: "tan", label: "小奶狗", note: "幼犬，哼哼唧唧", spec: { species: "dog", name: "团团", size: 0.7, age: 0.05, snout: 0.35, mood: "coax", texture: -0.3 } },
];
