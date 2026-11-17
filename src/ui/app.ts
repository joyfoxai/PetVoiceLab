/** The page: state, controls, and the draw loop. All sound decisions live in src/params. */
import { measurePetSound } from "../analysis/petsound.ts";
import { analysePetProsody, analyseProsody, finalSlope, ProsodyAnalyzer, type Prosody } from "../analysis/prosody.ts";
import { PetAudio } from "../audio/audio.ts";
import { renderInWorker, speakInWorker, wavBlob } from "../audio/offline.ts";
import { zipBlob } from "../audio/zip.ts";
import { CALLS, makeCall, MOOD_CALL, restFrame, type CallId } from "../params/calls.ts";
import { FIT_CALLS, fitSpec } from "../params/fit.ts";
import { bodyOf, characterOf, DEFAULT_SPEC, MOODS, type Mood, type PetSpec, type Species, type VoiceCharacter } from "../params/pet.ts";
import { PRESETS } from "../params/presets.ts";
import { petContour, prosodyToTrack } from "../params/prosody.ts";
import { hasCjk, textToProsody } from "../params/textprosody.ts";
import { decodeTelemetry, type Telemetry, type VoiceBody, type VoiceTrack } from "../params/protocol.ts";
import { ageWords, drawCard, drawWave, MOOD_ZH } from "./card.ts";
import { drawChart } from "./chart.ts";
import { COATS, CutawayFx, DEFAULT_VIEW, drawCutaway, NEON, type CoatId } from "./cutaway.ts";
import { shareUrl, specFromLocation } from "./share.ts";
import { pickMime, recordVideo, type VideoClock } from "./video.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const CALL_ZH: Record<CallId, string> = {
  meow: "喵",
  mew: "咪",
  trill: "咕噜叫",
  beckon: "过来",
  purr: "呼噜",
  hiss: "哈气",
  yowl: "嚎叫",
  chatter: "咔咔叫",
  caterwaul: "叫春",
  squeak: "吱",
  bark: "汪",
  yap: "吠吠",
  woof: "闷吠",
  bay: "猎吠",
  growl: "低吼",
  whine: "哼唧",
  whimper: "呜咽",
  yelp: "尖叫",
  howl: "长嚎",
  pant: "喘气",
  sigh: "叹气",
};
/** what it sounds like, written out: pops up over its head when it calls */
const CALL_SFX: Record<CallId, string> = {
  meow: "喵～",
  mew: "咪！",
  squeak: "吱",
  trill: "咕噜？",
  beckon: "咕噜～嗳",
  chatter: "咔咔咔",
  purr: "呼噜噜…",
  hiss: "哈——！",
  growl: "呜……",
  yowl: "嗷呜——",
  caterwaul: "喵嗷～～",
  bark: "汪！汪！",
  yap: "汪汪汪！",
  woof: "呜汪",
  bay: "嗷——汪",
  howl: "嗷呜～～",
  whine: "嘤…",
  whimper: "呜呜…",
  yelp: "嗷！",
  pant: "哈、哈、哈",
  sigh: "唉……",
};
const MAX_TRACT: Record<Species, number> = { cat: 10.4 * 1.12, dog: 26 * 1.12 };

/** A little face for each mood (40×40, drawn in the button's text colour). */
function moodFace(m: Mood): string {
  const eyes: Record<Mood, string> = {
    coax: '<circle cx="14" cy="18" r="3.6" fill="currentColor"/><circle cx="26" cy="18" r="3.6" fill="currentColor"/><circle cx="12.8" cy="16.6" r="1.1" fill="#fff"/><circle cx="24.8" cy="16.6" r="1.1" fill="#fff"/>',
    happy: '<path d="M10.5 19.5q3.5-5 7 0M22.5 19.5q3.5-5 7 0"/>',
    curious: '<circle cx="14" cy="19" r="2.2" fill="currentColor"/><circle cx="26" cy="18" r="3.4" fill="currentColor"/><path d="M22.5 11.5q3.5-2.5 7 0"/>',
    excited: '<path d="M10.5 15.5l6 3-6 3M29.5 15.5l-6 3 6 3"/>',
    sad: '<path d="M10.5 17q3 3.5 6.5 1.5M23 18.5q3.5 2 6.5-1.5"/><path d="M12 23q-2 3.2 0 4.2q2-1 0-4.2z" fill="#7fe3c4" stroke="none"/>',
    scared: '<circle cx="14" cy="17.5" r="3.6"/><circle cx="26" cy="17.5" r="3.6"/><circle cx="14" cy="17.5" r="1" fill="currentColor"/><circle cx="26" cy="17.5" r="1" fill="currentColor"/>',
    sleepy: '<path d="M10.5 18.5q3.5 2.5 7 0M22.5 18.5q3.5 2.5 7 0"/><path d="M29 7h4l-4 4h4" stroke-width="1.6"/>',
    angry: '<path d="M10 12.5l8 3.5M30 12.5l-8 3.5"/><circle cx="14.5" cy="19.5" r="2" fill="currentColor"/><circle cx="25.5" cy="19.5" r="2" fill="currentColor"/>',
  };
  const mouth: Record<Mood, string> = {
    coax: '<path d="M16 26q2 2.4 4 0q2 2.4 4 0"/>',
    happy: '<path d="M14 24.5q6 8 12 0z" fill="#ff8a73"/>',
    curious: '<circle cx="20" cy="27.5" r="2"/>',
    excited: '<ellipse cx="20" cy="27.5" rx="4.5" ry="3.8" fill="#ff8a73"/>',
    sad: '<path d="M15 29q5-4.5 10 0"/>',
    scared: '<path d="M14 28q2-2.5 4 0t4 0t4 0"/>',
    sleepy: '<path d="M17.5 27h5"/>',
    angry: '<path d="M15 29q5-3.5 10 0"/>',
  };
  return `<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${eyes[m]}${mouth[m]}</svg>`;
}
const MAX_RECORD_S = 10;
const FONT = '-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif';

interface Talk {
  prosody: Prosody;
  human: AudioBuffer | null;
  humanWave: Float32Array;
  contour: Float32Array;
  track: VoiceTrack;
  /** typed text, when the voice came from the keyboard */
  text: string;
  /** "rule": the tune was written from the text by rule and there is no voice to play back */
  /** "pet": the recording is an animal's own call, mimicked interval for interval */
  source: "voice" | "speech" | "rule" | "pet";
}

export class App {
  readonly audio = new PetAudio();
  spec: PetSpec = specFromLocation() ?? { ...DEFAULT_SPEC };
  body!: VoiceBody;
  character!: VoiceCharacter;
  readonly fx = new CutawayFx();
  private readonly videoFx = new CutawayFx();
  private rest: Telemetry | null = null;
  private restSeq = 0;
  private lastCall: CallId | null = null;
  private adjusting = false;

  private talk: Talk | null = null;
  private mic: { stop: () => void } | null = null;
  private analyzer: ProsodyAnalyzer | null = null;
  private pcm: Float32Array[] = [];
  private recTimer = 0;
  private playingTalk = false;
  private originalPlayer: AudioBufferSourceNode | null = null;
  private talkStartedAt = 0;
  private petLoop = false;
  private petLoopTimer = 0;
  private videoBlobUrl: string | null = null;
  private fitMic: { stop: () => void; sampleRate: number } | null = null;
  private fitPcm: Float32Array[] = [];
  private fitTimer = 0;
  private beforeFit: PetSpec | null = null;
  private lastTurn = 0;
  coat: CoatId = "orange";
  /** 0 = the pet's outside, 1 = see-through */
  xray = 0;
  private petSource = false;
  xrayOn = false;
  private recordingPet = false;
  private readonly still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  constructor() {
    this.derive();
    this.buildControls();
    this.syncControls();
    this.requestRest();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    // audio may only start from a gesture; any first touch anywhere arms it
    const arm = () => void this.audio.start().then(() => this.audio.setBody(this.body), () => this.showAudioError());
    window.addEventListener("pointerdown", arm, { once: true, capture: true });
    window.addEventListener("keydown", arm, { once: true, capture: true });
    window.addEventListener("hashchange", () => {
      const s = specFromLocation();
      if (s) this.setSpec(s, true);
    });
    (window as unknown as { __pv: App }).__pv = this;
  }

  // ------------------------------------------------------------------ parameter layer glue

  private derive(): void {
    this.body = bodyOf(this.spec);
    this.character = characterOf(this.spec);
  }

  /** Change the pet. `audition`: play its signature call once the body is in. */
  setSpec(patch: Partial<PetSpec>, audition = false): void {
    const speciesChanged = patch.species !== undefined && patch.species !== this.spec.species;
    this.spec = { ...this.spec, ...patch };
    this.derive();
    this.audio.setBody(this.body);
    this.requestRest();
    if (speciesChanged) this.lastCall = null;
    this.syncControls();
    if (this.talk) this.rebuildTalk();
    if (audition) this.replayCurrent();
  }

  /** The engine's own picture of this body at rest, for before the audio starts. */
  private requestRest(): void {
    const seq = ++this.restSeq;
    const rest = restFrame(this.character);
    const track: VoiceTrack = { keys: [{ t: 0, ...rest }, { t: 0.03, ...rest }], duration: 0.03 };
    void renderInWorker(this.body, track).then((r) => {
      if (seq === this.restSeq && r.snapshot.length) this.rest = decodeTelemetry(r.snapshot);
    }, () => {});
  }

  private signature(): CallId {
    return this.lastCall ?? MOOD_CALL[this.spec.species][this.spec.mood];
  }

  /** Touch → call. */
  sing(id?: CallId): void {
    if (id) this.lastCall = id;
    const call = id ?? MOOD_CALL[this.spec.species][this.spec.mood];
    void this.audio.start().then(() => {
      this.stopOriginal();
      this.stopPetLoop();
      this.playingTalk = false;
      this.audio.setLive(restFrame(this.character), 0);
      this.audio.play(makeCall(this.character, call));
      this.fx.bubbles.push({ text: CALL_SFX[call], born: performance.now() / 1000 });

    }, () => this.showAudioError());
    this.syncCalls(call);
  }

  private stopOriginal(): void {
    this.originalPlayer?.stop();
    this.originalPlayer = null;
  }

  private replayCurrent(): void {
    if (this.mic || this.fitMic) return;
    if (this.tab === "call") this.sing(this.signature());
    else if (this.talk) this.playTalk();
  }

  private adjust(key: "size" | "age" | "snout" | "texture", value: number): void {
    const lo = key === "texture" ? -1 : 0;
    const v = Math.round(Math.min(1, Math.max(lo, value)) * 100) / 100;
    if (v === this.spec[key]) return;
    if (!this.adjusting) {
      this.stopOriginal();
      this.stopPetLoop();
      this.audio.stop();
      this.playingTalk = false;
      this.adjusting = true;
    }
    this.spec = { ...this.spec, [key]: v };
    this.derive();
    $<HTMLInputElement>(key).value = String(v);
    this.syncReadouts();
    this.requestRest();
  }

  private endAdjust(): void {
    if (!this.adjusting) return;
    this.adjusting = false;
    this.setSpec({}, $<HTMLInputElement>("auto-replay").checked);
  }

  tab: "call" | "talk" = "call";
  private setTab(tab: App["tab"]): void {
    if (tab !== this.tab) {
      this.stopOriginal();
      this.stopPetLoop();
      this.audio.stop();
      this.playingTalk = false;
    }
    this.tab = tab;
    for (const id of ["call", "talk"] as const) {
      $(id).hidden = id !== tab;
      $("tab-" + id).setAttribute("aria-selected", String(id === tab));
    }
    this.syncTalkButtons();
    if (tab !== "talk" && this.mic) void this.stopRecording();
  }

  /** Each preset's card is a portrait drawn by the same renderer, from the engine's rest state for that body. */
  private async paintPresets(): Promise<void> {
    for (const p of PRESETS) {
      const canvas = document.querySelector<HTMLCanvasElement>(`#presets button[data-id="${p.id}"] canvas`);
      if (!canvas) continue;
      try {
        const c = characterOf(p.spec);
        const rest = restFrame(c);
        const r = await renderInWorker(bodyOf(p.spec), { keys: [{ t: 0, ...rest }, { t: 0.03, ...rest }], duration: 0.03 });
        const g = canvas.getContext("2d")!;
        g.clearRect(0, 0, canvas.width, canvas.height);
        const fx = new CutawayFx();
        fx.view = { yaw: -0.75, pitch: 0.12 };
        // every portrait at the same scale within its species, so size reads at a glance
        drawCutaway(g, { x: -canvas.width * 0.12, y: -canvas.height * 0.3, w: canvas.width * 1.5, h: canvas.height * 1.75 }, decodeTelemetry(r.snapshot), bodyOf(p.spec), p.spec, fx, { time: 0.5, maxTract: MAX_TRACT[p.spec.species] * 0.8, coat: COATS[p.coat], xray: 0, weight: 0.8 });
      } catch {
        /* a card without a portrait still works */
      }
    }
  }

  private showAudioError(): void {
    $("perf").textContent = "音频启动失败：" + (this.audio.error ?? "未知原因");
  }

  // ------------------------------------------------------------------ controls

  private buildControls(): void {
    const stage = $<HTMLCanvasElement>("stage");
    // a tap makes it call; a drag turns the head
    // a tap makes it call; dragging its nose changes the muzzle; two fingers or the wheel change
    // its size; any other drag turns the head
    let drag: { mode: "turn" | "snout"; x: number; y: number; yaw: number; pitch: number; snout: number; moved: boolean } | null = null;
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; size: number } | null = null;
    const spread = () => {
      const [a, b] = [...touches.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    stage.addEventListener("pointerdown", (e) => {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      stage.setPointerCapture(e.pointerId);
      if (touches.size === 2) {
        pinch = { dist: Math.max(20, spread()), size: this.spec.size };
        drag = null;
        return;
      }
      const r = stage.getBoundingClientRect();
      const [nx, ny] = this.fx.hit.nose;
      const onNose = Math.hypot(e.clientX - r.left - nx, e.clientY - r.top - ny) < Math.max(28, this.fx.hit.unit * 0.34);
      drag = { mode: onNose ? "snout" : "turn", x: e.clientX, y: e.clientY, yaw: this.fx.view.yaw, pitch: this.fx.view.pitch, snout: this.spec.snout, moved: false };
    });
    stage.addEventListener("pointermove", (e) => {
      if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size === 2) {
        this.adjust("size", pinch.size + Math.log2(spread() / pinch.dist) * 0.55);
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 7) return;
      drag.moved = true;
      if (drag.mode === "snout") {
        // pull the nose forward (to the right on screen) for a longer muzzle
        this.adjust("snout", drag.snout + dx / (this.fx.hit.unit * 1.4 + 70));
        return;
      }
      this.lastTurn = performance.now();
      this.fx.view.yaw = Math.max(-1.5, Math.min(1.5, drag.yaw + dx * 0.009));
      this.fx.view.pitch = Math.max(-0.7, Math.min(0.9, drag.pitch + dy * 0.006));
    });
    const release = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      if (pinch) {
        if (touches.size < 2) {
          pinch = null;
          this.endAdjust();
        }
        drag = null;
        return;
      }
      const d = drag;
      drag = null;
      if (d?.mode === "snout" && d.moved) this.endAdjust();
      else if (d && !d.moved && e.type === "pointerup") this.replayCurrent();
    };
    stage.addEventListener("pointerup", release);
    stage.addEventListener("pointercancel", release);
    let wheelTimer = 0;
    stage.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.adjust("size", this.spec.size - e.deltaY * 0.0011);
        clearTimeout(wheelTimer);
        wheelTimer = window.setTimeout(() => this.endAdjust(), 380);
      },
      { passive: false },
    );
    stage.addEventListener("keydown", (e) => {
      const step = { ArrowLeft: [-0.12, 0], ArrowRight: [0.12, 0], ArrowUp: [0, -0.08], ArrowDown: [0, 0.08] }[e.key];
      if (step) {
        e.preventDefault();
        this.lastTurn = performance.now();
        this.fx.view.yaw = Math.max(-1.5, Math.min(1.5, this.fx.view.yaw + step[0]));
        this.fx.view.pitch = Math.max(-0.7, Math.min(0.9, this.fx.view.pitch + step[1]));
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.replayCurrent();
      }
    });
    stage.addEventListener("dblclick", () => {
      this.fx.view = { ...DEFAULT_VIEW };
      this.lastTurn = 0;
    });
    $("start-hint").addEventListener("click", () => this.replayCurrent());

    $("species").addEventListener("click", (e) => {
      const v = (e.target as HTMLElement).closest("button")?.dataset.v as Species | undefined;
      if (v && v !== this.spec.species) {
        this.coat = v === "cat" ? "orange" : "shiba";
        this.setSpec({ species: v }, true);
      }
    });
    $("sculpt-toggle").addEventListener("click", () => {
      const dock = document.querySelector<HTMLElement>(".sculpt-sheet")!;
      $("sculpt-toggle").setAttribute("aria-expanded", String(dock.classList.toggle("expanded")));
    });
    // Both audition modes share the same sculpt controls.
    document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => b.addEventListener("click", () => this.setTab(b.dataset.tab as App["tab"])));
    // see-through: the airway inside, labels, and the numbers
    $("xray").addEventListener("click", () => {
      this.xrayOn = !this.xrayOn;
      $("xray").setAttribute("aria-pressed", String(this.xrayOn));
      this.syncReadouts();
    });
    $("mood-preview").addEventListener("click", () => this.replayCurrent());
    $("mood").replaceChildren(
      ...MOODS.map((m, i) => {
        const b = document.createElement("button");
        b.dataset.v = m;
        b.setAttribute("role", "radio");
        b.setAttribute("aria-label", MOOD_ZH[m]);
        b.title = MOOD_ZH[m];
        b.style.setProperty("--a", `${(360 / MOODS.length) * i}deg`);
        b.innerHTML = moodFace(m);
        return b;
      }),
    );
    $("mood").addEventListener("click", (e) => {
      const v = (e.target as HTMLElement).closest("button")?.dataset.v as Mood | undefined;
      if (v) {
        this.lastCall = null;
        this.setSpec({ mood: v }, true);
      }
    });
    const presets = $("presets");
    for (const p of PRESETS) {
      const b = document.createElement("button");
      b.dataset.id = p.id;
      b.title = p.note;
      const c = document.createElement("canvas");
      c.width = 144;
      c.height = 144;
      const label = document.createElement("span");
      label.textContent = p.label;
      b.append(c, label);
      b.addEventListener("click", () => {
        this.lastCall = null;
        $<HTMLDetailsElement>("preset-picker").open = false;
        this.coat = p.coat;
        this.setSpec({ ...p.spec }, true);
      });
      presets.append(b);
    }
    void this.paintPresets();
    $<HTMLInputElement>("name").addEventListener("input", (e) => {
      this.spec.name = (e.target as HTMLInputElement).value.slice(0, 12);
      this.syncReadouts();
    });
    for (const key of ["size", "age", "snout", "texture"] as const) {
      const el = $<HTMLInputElement>(key);
      el.addEventListener("input", () => this.adjust(key, Number(el.value)));
      el.addEventListener("change", () => this.endAdjust());
    }
    // every export lives in one dialog
    const exportDlg = $<HTMLDialogElement>("export-dialog");
    $("export-open").addEventListener("click", () => {
      const id = this.signature();
      $("export-call-note").textContent = `「${CALL_ZH[id]}」· WAV`;
      $("export-all-note").textContent = `ZIP，${CALLS[this.spec.species].length} 种叫声各一个 WAV`;
      this.setDockStatus(this.talk ? "" : "对讲机里还没有声音，后两项要先让它学一句话。");
      this.syncTalkButtons();
      exportDlg.showModal();
    });
    $("export-close").addEventListener("click", () => exportDlg.close());
    $("make-card").addEventListener("click", () => {
      exportDlg.close();
      void this.openCard();
    });
    $("card-close").addEventListener("click", () => $<HTMLDialogElement>("card-dialog").close());
    $("card-png").addEventListener("click", () => this.saveCard());
    $("card-link").addEventListener("click", () => void this.copyLink("card-status"));

    // step 2
    $("rec").addEventListener("click", () => void (this.mic ? this.stopRecording() : this.startRecording()));
    $<HTMLInputElement>("file").addEventListener("change", (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) void this.loadFile(f);
      (e.target as HTMLInputElement).value = "";
    });
    document.querySelectorAll<HTMLButtonElement>("#samples button").forEach((b) =>
      b.addEventListener("click", () => {
        void fetch(`./samples/${b.dataset.s}.wav`)
          .then((r) => r.blob())
          .then((blob) => this.loadFile(new File([blob], b.textContent ?? "sample.wav")))
          .catch(() => this.setTalkStatus("示例音频没有加载出来。", true));
      }),
    );
    $("play-pet").addEventListener("click", () => this.playTalk());
    $("play-human").addEventListener("click", () => {
      const original = this.talk?.human;
      if (!original) return;
      void this.audio.start().then(() => {
        this.stopOriginal();
        this.stopPetLoop();
        this.audio.stop();
        this.playingTalk = false;
        this.originalPlayer = this.audio.playBuffer(original);
      });
    });
    $("export-video").addEventListener("click", () => {
      $<HTMLDialogElement>("export-dialog").close();
      void this.exportVideo();
    });
    $("video-close").addEventListener("click", () => $<HTMLDialogElement>("video-dialog").close());
    $("pet-loop").addEventListener("click", () => (this.petLoop ? this.stopPetLoop() : this.startPetLoop()));
    // sculpt from its voice (in its own dialog)
    const fitDlg = $<HTMLDialogElement>("fit-dialog");
    $("fit-open").addEventListener("click", () => {
      this.setFitStatus("");
      fitDlg.showModal();
    });
    $("fit-close").addEventListener("click", () => fitDlg.close());
    fitDlg.addEventListener("close", () => void this.stopFitRecording(true));
    $("fit-rec").addEventListener("click", () => void (this.fitMic ? this.stopFitRecording() : this.startFitRecording()));
    $<HTMLInputElement>("fit-file").addEventListener("change", (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) void this.fitFromFile(f);
      (e.target as HTMLInputElement).value = "";
    });
    $("fit-undo").addEventListener("click", () => {
      if (!this.beforeFit) return;
      const back = this.beforeFit;
      this.beforeFit = null;
      $("fit-undo").hidden = true;
      this.setFitStatus("已恢复到听声之前的设置。");
      this.setSpec(back, true);
    });
    // who is on the recording: a person talking (default) or the pet itself
    $("src").addEventListener("click", (e) => {
      const v = (e.target as HTMLElement).closest("button")?.dataset.v;
      if (!v) return;
      this.petSource = v === "pet";
      document.querySelectorAll<HTMLButtonElement>("#src button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === v)));
      $("say-row").hidden = this.petSource;
      $("samples").hidden = this.petSource;
      this.setTalkStatus(this.petSource ? "录一段或上传一段它自己的叫声。捏出来的这只会按原样的音高起伏和节奏学一遍，点“原声”可以和真的对比。有明确音高的叫声（喵、哼唧、长嚎）学得最准。" : "只取音高、音量和节奏，不识别内容，声音不离开这台设备。试试把同一句话说成陈述句，再说成问句。");
    });
    // typed sentences
    const sayText = $<HTMLInputElement>("say-text");
    $("say-go").addEventListener("click", () => void this.sayText(sayText.value));
    sayText.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) void this.sayText(sayText.value);
    });
    // sound export
    $("export-call").addEventListener("click", () => void this.exportCall());
    $("export-all").addEventListener("click", () => void this.exportAllCalls());
    $("export-talk").addEventListener("click", () => void this.exportTalk());
    if (!pickMime()) $("export-video").title = "这个浏览器不支持录制视频";
  }

  private syncControls(): void {
    const s = this.spec;
    document.querySelectorAll<HTMLButtonElement>("#species button[data-v]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === s.species)));
    document.querySelectorAll<HTMLButtonElement>("#mood button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === s.mood)));
    $("mood-name").textContent = MOOD_ZH[s.mood];
    $<HTMLInputElement>("name").value = s.name;
    for (const key of ["size", "age", "snout", "texture"] as const) $<HTMLInputElement>(key).value = String(s[key]);
    document.querySelectorAll<HTMLButtonElement>("#presets button").forEach((b) => {
      const p = PRESETS.find((q) => q.id === b.dataset.id)!;
      b.hidden = p.spec.species !== s.species;
      const same = (["size", "age", "snout", "texture"] as const).every((k) => Math.abs(p.spec[k] - s[k]) < 0.005) && p.spec.mood === s.mood;
      b.setAttribute("aria-pressed", String(same));
    });
    const calls = $("calls");
    calls.replaceChildren(
      ...CALLS[s.species].map((id) => {
        const b = document.createElement("button");
        b.dataset.id = id;
        b.textContent = CALL_ZH[id];
        b.addEventListener("click", () => this.sing(id));
        return b;
      }),
    );
    // the calls a recording can be declared as, for "sculpt from its voice"
    const fitCall = $<HTMLSelectElement>("fit-call");
    const keep = fitCall.value;
    fitCall.replaceChildren(
      ...(Object.keys(FIT_CALLS[s.species]) as CallId[]).map((id) => {
        const o = document.createElement("option");
        o.value = id;
        o.textContent = CALL_ZH[id];
        return o;
      }),
    );
    if ([...fitCall.options].some((o) => o.value === keep)) fitCall.value = keep;
    this.syncCalls(this.signature());
    this.syncReadouts();
  }

  private syncCalls(active: CallId): void {
    $("mood-preview").setAttribute("aria-label", `试听${MOOD_ZH[this.spec.mood]}的${CALL_ZH[active]}`);
    document.querySelectorAll<HTMLButtonElement>("#calls button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === active)));
  }

  private syncReadouts(): void {
    const s = this.spec;
    const c = this.character;
    const word = (v: number, words: string[]) => words[Math.min(words.length - 1, Math.floor(v * words.length))];
    const num = this.xrayOn;
    for (const key of ["size", "age", "snout", "texture"] as const) {
      const fraction = key === "texture" ? (s[key] + 1) / 2 : s[key];
      $(key).style.setProperty("--filled", fraction * 100 + "%");
    }
    $("v-size").textContent = num ? `声道 ${c.tractLen.toFixed(1)} cm` : word(s.size, ["小不点", "小个子", "中等个头", "大个子", "大块头"]);
    $("v-age").textContent = num ? `${ageWords(s)} · 基频 ${Math.round(c.f0)} Hz` : ageWords(s);
    $("v-snout").textContent = num ? `口腔 ${this.body.oralLen.toFixed(1)} cm` : word(s.snout, ["扁扁脸", "短鼻子", "不长不短", "长鼻子", "很长的鼻子"]);
    $("v-texture").textContent = s.texture < -0.5 ? "清亮" : s.texture < -0.15 ? "偏清亮" : s.texture <= 0.15 ? "适中" : s.texture <= 0.5 ? "偏沙哑" : "沙哑";
    // the name box hugs its text (CJK characters are about twice as wide as Latin ones)
    const nameBox = $<HTMLInputElement>("name");
    const units = [...(nameBox.value || nameBox.placeholder)].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e7f ? 1 : 0.56), 0);
    nameBox.style.width = `calc(${units.toFixed(2)}em + 16px)`;
    const name = s.name || "它";
    $("preset-label").textContent = name + " · " + (s.species === "cat" ? "猫" : "狗");
    $("pet-output").textContent = name + "的声音";
    $("play-pet").textContent = "▶ 听" + name + "学说话";
    $("start-hint").textContent = "▷ 点" + name + "，再听一次";
    this.syncTalkButtons();
  }

  // ------------------------------------------------------------------ voiceprint card

  private async openCard(): Promise<void> {
    const dlg = $<HTMLDialogElement>("card-dialog");
    const status = $("card-status");
    status.textContent = "正在离线渲染这只宠物的招牌叫声…";
    if (!dlg.open) dlg.showModal();
    const call = this.signature();
    try {
      const r = await renderInWorker(this.body, makeCall(this.character, call));
      const url = shareUrl(this.spec);
      drawCard($<HTMLCanvasElement>("card"), { spec: this.spec, body: this.body, character: this.character, callName: CALL_ZH[call], samples: r.samples, sampleRate: r.sampleRate, snapshot: r.snapshot, url, maxTract: MAX_TRACT[this.spec.species], coat: COATS[this.coat] });
      try {
        history.replaceState(null, "", url);
      } catch {
        location.hash = new URL(url).hash; // sandboxed hosts refuse replaceState
      }
      status.textContent = "卡片里的剖面是引擎在叫声最响那一刻的真实状态。链接里带着全部参数。";
    } catch (err) {
      status.textContent = "渲染失败：" + String(err);
    }
  }

  private saveCard(): void {
    $<HTMLCanvasElement>("card").toBlob((b) => b && void download(b, `${this.spec.name || "pet"}-voiceprint.png`).then((m) => m && ($("card-status").textContent = m)), "image/png");
  }

  private async copyLink(statusId: string): Promise<void> {
    const url = shareUrl(this.spec);
    try {
      await navigator.clipboard.writeText(url);
      $(statusId).textContent = "链接已复制：" + url;
    } catch {
      $(statusId).textContent = "复制被浏览器拦下了，请手动复制这条链接：" + url;
    }
  }

  // ------------------------------------------------------------------ step 2: talk

  private setTalkStatus(text: string, err = false): void {
    const el = $("talk-status");
    el.textContent = text;
    el.classList.toggle("err", err);
  }

  private async startRecording(): Promise<void> {
    try {
      this.stopOriginal();
      this.stopPetLoop();
      this.audio.stop();
      this.pcm = [];
      this.talk = null;
      this.syncTalkButtons();
      const pet = this.petSource;
      const mic = await this.audio.openMic(
        (x) => {
          this.pcm.push(x);
          this.analyzer?.push(x);
        },
        { raw: pet },
      );
      // an animal is analysed in one pass when the recording stops (no live curve)
      this.analyzer = pet ? null : new ProsodyAnalyzer(mic.sampleRate);
      this.recordingPet = pet;
      this.mic = mic;
      $("rec").classList.add("on");
      $("rec").querySelector("span")!.textContent = "停止";
      this.setTalkStatus(`正在听…最长 ${MAX_RECORD_S} 秒，说完点“停止”。`);
      this.recTimer = window.setTimeout(() => void this.stopRecording(), MAX_RECORD_S * 1000);
    } catch (err) {
      this.setTalkStatus(micProblem(err) + "可以改用上传音频、打字或示例句。", true);
    }
  }

  private async stopRecording(): Promise<void> {
    if (!this.mic) return;
    clearTimeout(this.recTimer);
    this.mic.stop();
    this.mic = null;
    $("rec").classList.remove("on");
    $("rec").querySelector("span")!.textContent = "重新录音";
    const analyzer = this.analyzer;
    this.analyzer = null;
    const ctx = this.audio.ctx;
    if (!ctx || (!analyzer && !this.recordingPet)) return;
    const n = this.pcm.reduce((a, b) => a + b.length, 0);
    const all = new Float32Array(n);
    let o = 0;
    for (const c of this.pcm) {
      all.set(c, o);
      o += c.length;
    }
    this.pcm = [];
    if (analyzer) this.acceptVoice(analyzer.finish(), all, ctx.sampleRate);
    else this.acceptVoice(analysePetProsody(all, ctx.sampleRate), all, ctx.sampleRate, "", "pet");
  }

  private async loadFile(f: File): Promise<void> {
    try {
      await this.audio.start();
      const ctx = this.audio.ctx!;
      this.setTalkStatus("正在解码 " + f.name + " …");
      const buf = await ctx.decodeAudioData(await f.arrayBuffer());
      const n = Math.min(buf.length, Math.floor(12 * buf.sampleRate));
      const mono = new Float32Array(n);
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels;
      }
      if (this.petSource) this.acceptVoice(analysePetProsody(mono, buf.sampleRate), mono, buf.sampleRate, "", "pet");
      else this.acceptVoice(analyseProsody(mono, buf.sampleRate), mono, buf.sampleRate);
    } catch (err) {
      this.setTalkStatus("读不了这个文件：" + ((err as Error)?.message ?? err), true);
    }
  }

  /** A recorded or uploaded voice with its prosody → the pet's version. */
  private acceptVoice(prosody: Prosody, pcm: Float32Array, sampleRate: number, text = "", source: Talk["source"] = "voice"): void {
    const voiced = Array.from(prosody.f0).filter((v) => v > 0).length;
    const sounding = prosody.active.reduce((a, b) => a + b, 0);
    if (source === "pet" && sounding < 10) {
      this.setTalkStatus("没录到叫声（太短或太轻）。离它近一点再试一次。", true);
      return;
    }
    if (source !== "pet" && voiced < 8) {
      this.setTalkStatus("没听出带音高的人声（太短、太轻或只有噪声）。离麦克风近一点再试一次。", true);
      return;
    }
    let human: AudioBuffer | null = null;
    const ctx = this.audio.ctx;
    if (ctx && pcm.length) {
      human = ctx.createBuffer(1, pcm.length, sampleRate);
      human.getChannelData(0).set(pcm);
    }
    this.talk = { prosody, human, humanWave: pcm, contour: new Float32Array(0), track: { keys: [], duration: 0 }, text, source };
    if (human) {
      const wave = $<HTMLCanvasElement>("original-wave");
      const g = wave.getContext("2d")!;
      g.clearRect(0, 0, wave.width, wave.height);
      drawWave(g, pcm, 0, 0, wave.width, wave.height);
      $("original-duration").textContent = human.duration.toFixed(1) + " s";
    }
    this.rebuildTalk();
    const slope = finalSlope(prosody.f0, prosody.hop);
    const tune = slope > 1.5 ? `句尾上扬 ${slope.toFixed(1)} 个半音（像问句）` : slope < -1.5 ? `句尾下降 ${Math.abs(slope).toFixed(1)} 个半音（像陈述句）` : "句尾基本持平";
    const who = this.spec.name || "它";
    if (source === "pet") this.setTalkStatus(voiced >= 8 ? `听到它叫了 ${(sounding * prosody.hop).toFixed(1)} 秒，音高 ${Math.round(prosody.medianF0)} Hz 上下，${tune.replace(/（像.+?）/, "")}。${who}按原样的起伏和节奏学了一遍，移到了自己的音高（${Math.round(this.character.f0)} Hz）。点“原声”对比。` : `听到 ${(sounding * prosody.hop).toFixed(1)} 秒没有音高的声音（哈气、喘气或太嘈杂），${who}只学了节奏和气息。`);
    else if (source === "rule") this.setTalkStatus(`按文字规则写的语调（没有合成人声，也不含四声）：${prosody.syllables.length} 个音节，${tune}。${who}会照着这条曲线叫。`);
    else if (source === "speech") this.setTalkStatus(`合成人声念了 ${prosody.duration.toFixed(1)} 秒、${prosody.syllables.length} 个音节，${tune}。点“原声”能听到它，${who}照着它叫。`);
    else this.setTalkStatus(`听到 ${prosody.duration.toFixed(1)} 秒、${prosody.syllables.length} 个音节，你的中位音高 ${Math.round(prosody.medianF0)} Hz，${tune}。${who}会照着这条曲线叫。`);
    if (this.tab === "talk") this.playTalk();
  }

  private rebuildTalk(): void {
    if (!this.talk) return;
    const fromPet = this.talk.source === "pet";
    this.talk.contour = petContour(this.talk.prosody, this.character, fromPet ? 1 : undefined);
    this.talk.track = prosodyToTrack(this.talk.prosody, this.character, { fromPet });
    this.syncTalkButtons();
  }

  private syncTalkButtons(): void {
    const has = !!this.talk;
    $("original-clip").hidden = !this.talk?.human;
    $<HTMLButtonElement>("start-hint").disabled = this.tab === "talk" && !has;
    $<HTMLButtonElement>("play-pet").disabled = !has;
    $<HTMLButtonElement>("play-human").disabled = !this.talk?.human;
    $<HTMLButtonElement>("export-video").disabled = !has || !pickMime();
    $<HTMLButtonElement>("export-talk").disabled = !has;
    $<HTMLButtonElement>("pet-loop").disabled = !has && !this.petLoop;
  }

  playTalk(): void {
    if (!this.talk) return;
    const track = this.talk.track;
    void this.audio.start().then(() => {
      this.stopOriginal();
      this.stopPetLoop();
      this.audio.setLive(restFrame(this.character), 0);
      this.playingTalk = true;
      this.talkStartedAt = performance.now();
      this.audio.play(track);
    });
  }

  /** A typed sentence: English is spoken by the synthetic human voice, Chinese gets a rule-made tune. */
  private async sayText(raw: string): Promise<void> {
    const text = raw.trim().slice(0, 120);
    if (!text) {
      this.setTalkStatus("先打一句话。英文会用合成人声念出来，中文按标点生成语调。", true);
      return;
    }
    this.stopPetLoop();
    if (hasCjk(text)) {
      const prosody = textToProsody(text);
      if (!prosody) {
        this.setTalkStatus("这句话里没有能念的字。", true);
        return;
      }
      await this.audio.start().catch(() => {});
      this.acceptVoice(prosody, new Float32Array(0), 48000, text, "rule");
      return;
    }
    this.setTalkStatus("正在合成人声…（第一次要加载约 1.4 MB 的发音模块）");
    try {
      const [r] = await Promise.all([speakInWorker(text), this.audio.start()]);
      if (!r.samples.length) {
        this.setTalkStatus("这句话里没有能念的词。", true);
        return;
      }
      this.acceptVoice(analyseProsody(r.samples, r.sampleRate), r.samples, r.sampleRate, text, "speech");
    } catch (err) {
      this.setTalkStatus("合成人声失败：" + ((err as Error)?.message ?? err), true);
    }
  }

  // ------------------------------------------------------------------ sculpt from its voice

  private setFitStatus(text: string, err = false): void {
    const el = $("fit-status");
    el.textContent = text;
    el.classList.toggle("err", err);
  }

  private async startFitRecording(): Promise<void> {
    try {
      this.stopOriginal();
      this.stopPetLoop();
      this.audio.stop();
      this.fitPcm = [];
      // a pet is not speech: the browser's noise suppression and gain control would mangle it
      const mic = await this.audio.openMic((x) => this.fitPcm.push(x), { raw: true });
      this.fitMic = mic;
      $("fit-rec").classList.add("on");
      $("fit-rec").querySelector("span")!.textContent = "停止";
      this.setFitStatus("正在录…让它叫一两声，最长 8 秒。");
      this.fitTimer = window.setTimeout(() => void this.stopFitRecording(), 8000);
    } catch (err) {
      this.setFitStatus(micProblem(err) + "可以改用上传音频。", true);
    }
  }

  private async stopFitRecording(discard = false): Promise<void> {
    const mic = this.fitMic;
    if (!mic) return;
    clearTimeout(this.fitTimer);
    mic.stop();
    this.fitMic = null;
    $("fit-rec").classList.remove("on");
    $("fit-rec").querySelector("span")!.textContent = "录它的叫声";
    const n = this.fitPcm.reduce((a, b) => a + b.length, 0);
    const all = new Float32Array(n);
    let o = 0;
    for (const c of this.fitPcm) {
      all.set(c, o);
      o += c.length;
    }
    this.fitPcm = [];
    if (!discard) this.fitFrom(all, mic.sampleRate);
  }

  private async fitFromFile(f: File): Promise<void> {
    try {
      await this.audio.start();
      this.setFitStatus("正在解码 " + f.name + " …");
      const buf = await this.audio.ctx!.decodeAudioData(await f.arrayBuffer());
      const n = Math.min(buf.length, Math.floor(15 * buf.sampleRate));
      const mono = new Float32Array(n);
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels;
      }
      this.fitFrom(mono, buf.sampleRate);
    } catch (err) {
      this.setFitStatus("读不了这个文件：" + ((err as Error)?.message ?? err), true);
    }
  }

  /** A recording of the real pet → sliders. The call it is declared as comes from the select. */
  fitFrom(pcm: Float32Array, sampleRate: number): void {
    const call = $<HTMLSelectElement>("fit-call").value as CallId;
    const m = measurePetSound(pcm, sampleRate);
    const fit = fitSpec(m, this.spec, call);
    if (!fit.ok) {
      this.setFitStatus(fit.note, true);
      return;
    }
    this.beforeFit = { ...this.spec };
    $("fit-undo").hidden = false;
    const heard: string[] = [];
    if (fit.used.pitch) heard.push(`音高 ${Math.round(m.f0)} Hz`);
    if (fit.used.tract) heard.push(`声道约 ${fit.tractLen.toFixed(1)} cm`);
    if (fit.used.texture) heard.push(`谐噪比 ${m.hnr.toFixed(0)} dB`);
    const c = characterOf(fit.spec);
    this.setFitStatus(`听到：${heard.join("、")}。已把体型调到 ${Math.round(fit.spec.size * 100)}%${fit.spec.age !== this.spec.age ? `、年龄调到“${ageWords(fit.spec)}”` : ""}${fit.used.texture ? `、质地 ${fit.spec.texture.toFixed(2)}` : ""}（声道 ${c.tractLen.toFixed(1)} cm，基频 ${Math.round(c.f0)} Hz）。${fit.note}年龄和口鼻听不出来，没有动。`);
    this.lastCall = call;
    this.setSpec(fit.spec, false);
    this.sing(call);
  }

  // ------------------------------------------------------------------ sound export

  private setDockStatus(text: string, err = false): void {
    const el = $("export-status");
    el.textContent = text;
    el.classList.toggle("err", err);
  }

  private fileStem(): string {
    return (this.spec.name || "pet").replace(/[\\/:*?"<>|]/g, "");
  }

  private async exportCall(): Promise<void> {
    const id = this.signature();
    try {
      this.setDockStatus(`正在渲染「${CALL_ZH[id]}」…`);
      const r = await renderInWorker(this.body, makeCall(this.character, id));
      const msg = await download(wavBlob(r.samples, r.sampleRate), `${this.fileStem()}-${id}.wav`);
      this.setDockStatus(msg ?? `已导出「${CALL_ZH[id]}」（${(r.samples.length / r.sampleRate).toFixed(1)} 秒，48 kHz WAV）。`, !!msg);
    } catch (err) {
      this.setDockStatus("导出失败：" + String(err), true);
    }
  }

  private async exportAllCalls(): Promise<void> {
    try {
      const files: { name: string; data: Uint8Array }[] = [];
      const ids = CALLS[this.spec.species];
      for (const [i, id] of ids.entries()) {
        this.setDockStatus(`正在渲染 ${i + 1}/${ids.length}：${CALL_ZH[id]}…`);
        const r = await renderInWorker(this.body, makeCall(this.character, id));
        files.push({ name: `${this.fileStem()}-${id}.wav`, data: new Uint8Array(await wavBlob(r.samples, r.sampleRate).arrayBuffer()) });
      }
      const msg = await download(zipBlob(files), `${this.fileStem()}-calls.zip`);
      this.setDockStatus(msg ?? `已导出 ${ids.length} 种叫声（ZIP，里面是 48 kHz WAV）。`, !!msg);
    } catch (err) {
      this.setDockStatus("导出失败：" + String(err), true);
    }
  }

  private async exportTalk(): Promise<void> {
    if (!this.talk) return;
    try {
      this.setDockStatus("正在渲染…");
      const r = await renderInWorker(this.body, this.talk.track);
      const msg = await download(wavBlob(r.samples, r.sampleRate), `${this.fileStem()}-says.wav`);
      this.setDockStatus(msg ?? `已导出它说的这句（${(r.samples.length / r.sampleRate).toFixed(1)} 秒，48 kHz WAV）。`, !!msg);
    } catch (err) {
      this.setDockStatus("导出失败：" + String(err), true);
    }
  }

  // ------------------------------------------------------------------ play to a real pet

  private loopTrack(): { track: VoiceTrack } {
    return { track: this.talk ? this.talk.track : makeCall(this.character, this.signature()) };
  }

  private startPetLoop(): void {
    void this.audio.start().then(() => {
      this.petLoop = true;
      $("pet-loop").textContent = "■ 停止循环";
      this.audio.setMaster(1.6);
      const gap = 4000;
      $("pet-note").hidden = false;
      const once = () => {
        if (!this.petLoop) return;
        const { track } = this.loopTrack();
        this.playingTalk = !!this.talk;
        this.talkStartedAt = performance.now();
        this.audio.play(track, { volume: 1.5, onEnded: () => (this.petLoopTimer = window.setTimeout(once, gap)) });
      };
      once();
    });
  }

  private stopPetLoop(): void {
    if (!this.petLoop) return;
    this.petLoop = false;
    clearTimeout(this.petLoopTimer);
    this.audio.stop();
    this.audio.setMaster(1);
    $("pet-loop").textContent = "循环放给宠物听";
    $("pet-note").hidden = true;
  }

  // ------------------------------------------------------------------ video

  private async exportVideo(): Promise<void> {
    if (!this.talk) return;
    const dlg = $<HTMLDialogElement>("video-dialog");
    const canvas = $<HTMLCanvasElement>("video-canvas");
    const out = $<HTMLVideoElement>("video-out");
    const save = $<HTMLButtonElement>("video-save");
    const share = $<HTMLButtonElement>("video-share");
    const status = $("video-status");
    canvas.hidden = false;
    out.hidden = true;
    save.hidden = true;
    share.hidden = true;
    status.textContent = "正在录制（实时，约 10 秒）…请保持页面在前台";
    dlg.showModal();
    const talk = this.talk;
    const g = canvas.getContext("2d")!;
    try {
      this.stopPetLoop();
      const res = await recordVideo({ audio: this.audio, canvas, human: talk.human, track: talk.track, draw: (clock) => this.drawVideoFrame(g, canvas.width, canvas.height, talk, clock) });
      if (this.videoBlobUrl) URL.revokeObjectURL(this.videoBlobUrl);
      this.videoBlobUrl = URL.createObjectURL(res.blob);
      const name = `${this.spec.name || "pet"}-says.${res.ext}`;
      out.src = this.videoBlobUrl;
      out.hidden = false;
      canvas.hidden = true;
      save.hidden = false;
      save.onclick = () => void download(res.blob, name).then((m) => m && (status.textContent = m));
      status.textContent = `录好了：${res.seconds.toFixed(1)} 秒，${(res.blob.size / 1e6).toFixed(1)} MB，${res.ext.toUpperCase()}。`;
      const file = new File([res.blob], name, { type: res.blob.type });
      if (navigator.canShare?.({ files: [file] })) {
        share.hidden = false;
        share.onclick = () => void navigator.share({ files: [file], title: `${this.spec.name}说` }).catch(() => {});
      }
      (window as unknown as { __pvVideo?: Blob }).__pvVideo = res.blob;
    } catch (err) {
      this.audio.immediate = false;
      status.textContent = "导出失败：" + ((err as Error)?.message ?? err);
    }
  }

  private drawVideoFrame(g: CanvasRenderingContext2D, W: number, H: number, talk: Talk, clock: VideoClock): void {
    g.fillStyle = NEON.bg;
    g.fillRect(0, 0, W, H);
    const grad = g.createRadialGradient(W * 0.55, H * 0.42, 40, W * 0.55, H * 0.42, H * 0.6);
    grad.addColorStop(0, "#3a2247");
    grad.addColorStop(1, NEON.bg);
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    g.textBaseline = "alphabetic";
    g.textAlign = "left";
    g.font = `700 58px ${FONT}`;
    g.fillStyle = NEON.lime;
    g.fillText(`${this.spec.name || "它"}说：`, 44, 110);
    g.font = `26px ${FONT}`;
    g.fillStyle = NEON.mute;
    g.fillText(`${this.spec.species === "cat" ? "猫" : "狗"} · 声道 ${this.character.tractLen.toFixed(1)} cm · 基频 ${Math.round(this.character.f0)} Hz`, 46, 156);
    // the person's clip
    const hy = 190;
    g.fillStyle = clock.human >= 0 ? NEON.line : NEON.mute;
    g.font = `28px ${FONT}`;
    const who = talk.source === "pet" ? "原声" : "你说";
    g.fillText(clock.human >= 0 ? who + " ▶" : who, 44, hy + 34);
    if (!talk.humanWave.length && talk.text) {
      g.fillStyle = NEON.text;
      g.font = `30px ${FONT}`;
      g.fillText(talk.text.length > 16 ? talk.text.slice(0, 15) + "…" : talk.text, 150, hy + 36);
    }
    if (talk.humanWave.length) {
      g.globalAlpha = clock.human >= 0 ? 1 : 0.45;
      drawWave(g, talk.humanWave, 150, hy, W - 194, 56);
      g.globalAlpha = 1;
      if (clock.human >= 0) {
        g.fillStyle = "#fff";
        g.fillRect(150 + clock.human * (W - 194), hy, 2, 56);
      }
    }
    const tele = this.audio.telemetry() ?? this.rest;
    if (tele) drawCutaway(g, { x: 10, y: 270, w: W - 20, h: 600 }, tele, this.body, this.spec, this.videoFx, { time: performance.now() / 1000, weight: 1.25, maxTract: MAX_TRACT[this.spec.species], sway: this.still ? 0 : 0.2, coat: COATS[this.coat], xray: this.xray });
    drawChart(
      g,
      { x: 30, y: 900, w: W - 60, h: 270 },
      { prosody: talk.prosody, pet: talk.contour, petMedian: this.character.f0, playhead: clock.petTake >= 0 && tele ? tele.trackTime : -1, engineF0: tele && tele.voicing > 0.3 ? tele.f0 : 0, humanLabel: talk.source === "pet" ? "原叫声" : "你的音高", petLabel: `${this.spec.name || "它"}的音高` },
      20,
    );
    g.font = `22px ui-monospace, SFMono-Regular, Menlo, monospace`;
    g.fillStyle = NEON.mute;
    g.textAlign = "center";
    g.fillText("PetVoice Lab · 物理建模声道合成，非录音", W / 2, H - 44);
    // progress
    g.fillStyle = NEON.hot;
    g.fillRect(0, H - 8, W * Math.min(1, clock.t / clock.total), 8);
  }

  // ------------------------------------------------------------------ draw loop

  private fit(c: HTMLCanvasElement): CanvasRenderingContext2D {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return g;
  }

  private loop(now: number): void {
    requestAnimationFrame(this.loop);
    const stage = $<HTMLCanvasElement>("stage");
    if (!stage.clientWidth) return;
    const g = this.fit(stage);
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    g.clearRect(0, 0, w, h);
    const live = this.audio.telemetry();
    const tele = this.adjusting ? this.rest ?? live : live ?? this.rest;
    // the head sways a little when nobody has turned it for a few seconds
    const sway = this.still || now - this.lastTurn < 4000 ? 0 : 0.14;
    // the pet gets the part of the window the sheet does not cover
    const sound = document.querySelector<HTMLElement>(".sound-sheet")!.getBoundingClientRect();
    const sculpt = document.querySelector<HTMLElement>(".sculpt-sheet")!.getBoundingClientRect();
    const top = 56;
    const mobile = sound.width > w * 0.9;
    const area = mobile ? { x: 0, y: top, w, h: Math.max(60, sound.top - top) } :
      { x: sculpt.right, y: top, w: sound.left - sculpt.right, h: h - top - 48 };
    this.xray += ((this.xrayOn ? 1 : 0) - this.xray) * 0.16;
    const portrait = mobile ? area : { x: area.x - area.w * 0.16, y: area.y - area.h * 0.16, w: area.w * 1.32, h: area.h * 1.32 };
    if (tele) drawCutaway(g, portrait, tele, this.body, this.spec, this.fx, { time: now / 1000, labels: true, maxTract: MAX_TRACT[this.spec.species], sway, coat: COATS[this.coat], xray: this.xray, handles: !this.xrayOn });
    const hint = $("start-hint");
    hint.style.left = `${area.x + area.w / 2}px`;
    hint.style.top = `${mobile ? sound.top - 38 : h - 60}px`;
    if (live) {
      $("stage-foot").textContent = !this.xrayOn ? "" : live.voicing > 0.3 && live.gate > 0.05 ? `声带 ${Math.round(live.f0)} Hz · 嘴张开 ${(live.frame.jaw * 100).toFixed(0)}%` : live.gate > 0.05 ? "只有气流，声带没有振动" : "";
      // telemetry lags by the output latency: do not mistake the moment before the call for its end
      if (live.trackTime < 0 && now - this.talkStartedAt > 400) this.playingTalk = false;
    }
    {
      const chart = $<HTMLCanvasElement>("chart");
      const cg = this.fit(chart);
      const t = this.talk;
      drawChart(cg, { x: 0, y: 0, w: chart.clientWidth, h: chart.clientHeight }, {
        prosody: t?.prosody ?? null,
        pet: t?.contour ?? null,
        petMedian: this.character.f0,
        live: this.analyzer ? { f0: this.analyzer.frames.map((f) => (f.clarity > 0.6 && f.rms > 0.004 ? f.f0 : 0)), hop: 0.01 } : undefined,
        playhead: this.playingTalk && live ? live.trackTime : -1,
        engineF0: live && live.voicing > 0.3 ? live.f0 : 0,
        humanLabel: t?.source === "pet" ? "原叫声" : "你的音高",
        petLabel: `${this.spec.name || "它"}的音高`,
      });
    }
    if (this.audio.error) this.showAudioError();
    else if (this.audio.ctx) {
      const a = this.audio;
      $("perf").textContent = !this.xrayOn ? "" : `试听延迟 ≈ ${a.latencyMs ? Math.round(a.latencyMs) + " ms" : "—"} · 引擎负载 ${Math.round(a.load * 100)}% · ${a.ctx!.sampleRate} Hz${a.economy ? " · 省电模式" : ""}`;
    } else $("perf").textContent = "";
  }
}

interface HostDownloads {
  save(r: { filename: string; data: Blob }): Promise<unknown>;
}
type HostWindow = Window & { claude?: { use(name: string): Promise<unknown> } };

/**
 * Save a file. In an ordinary browser tab: a download link. Inside a host that sandboxes
 * downloads (a claude.ai Artifact), plain links are inert, so ask the host's save dialog instead.
 * Returns a message when the file could not be offered.
 */
async function download(blob: Blob, name: string): Promise<string | null> {
  const host = (window as HostWindow).claude;
  if (host?.use) {
    const dl = (await host.use("downloads").catch(() => null)) as HostDownloads | null;
    if (!dl) return "这个页面所在的环境不允许保存文件";
    try {
      // the host's save dialog takes a fixed list of file types, and WAV is not on it
      if (/\.wav$/i.test(name)) {
        blob = zipBlob([{ name, data: new Uint8Array(await blob.arrayBuffer()) }]);
        name = name.replace(/\.wav$/i, ".zip");
      }
      await dl.save({ filename: name, data: blob });
      return null;
    } catch (err) {
      const code = (err as { code?: string })?.code;
      return code === "declined" ? "已取消保存" : code === "rejected_extension" ? "这个环境不允许保存这种格式的文件" : "保存失败（" + (code ?? "未知原因") + "）";
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  return null;
}

/** Why the microphone did not open, in words a person can act on. */
function micProblem(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";
  if ((window as HostWindow).claude) return "这个页面所在的环境不开放麦克风（正式部署到 HTTPS 站点后才会弹出授权）。";
  if (name === "NotAllowedError" || name === "SecurityError") return "麦克风权限被拒绝了。请点地址栏左侧的站点设置，把麦克风改成“允许”，再点一次录音。";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "没有找到麦克风。";
  if (!navigator.mediaDevices?.getUserMedia) return "这个浏览器或这个地址不支持麦克风（需要 HTTPS 或 localhost）。";
  return "打不开麦克风：" + ((err as Error)?.message ?? String(err)) + "。";
}
