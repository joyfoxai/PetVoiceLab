// Records the 1-minute demo: sculpt a cat, speak through it, export a video.
// Picture: Playwright's page video. Sound: the page's own audio graph, recorded in the page.
// The "spoken" sentence comes from a fake microphone fed with test-audio/ (synthetic speech) and
// is mixed back in at the moment recording started. Needs `npm run preview` running, and ffmpeg.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const { chromium } = createRequire(import.meta.url)("playwright");

const url = process.env.PV_URL ?? "http://127.0.0.1:4173/";
const mic = resolve("test-audio/question-female.wav");
const tmp = resolve("out/demo-tmp");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
mkdirSync("demo", { recursive: true });

const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${mic}%noloop`] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, recordVideo: { dir: tmp, size: { width: 1440, height: 810 } }, permissions: ["microphone"] });
const page = await ctx.newPage();
const videoStart = Date.now();
await page.goto(url);
await page.waitForFunction(() => window.__pv);
await page.addStyleTag({ content: `#cap{position:fixed;left:36%;bottom:22px;transform:translateX(-50%);z-index:99999;background:rgba(23,15,32,.92);border:1px solid #ffd27a;color:#fff3e4;padding:10px 18px;border-radius:12px;font:600 20px system-ui,"WenQuanYi Zen Hei",sans-serif;max-width:90vw;text-align:center;pointer-events:none}` });
// captions live in the top layer when a dialog is open, so re-parent on demand
const cap = (text) => page.evaluate((t) => {
  let el = document.getElementById("cap");
  if (!el) { el = document.createElement("div"); el.id = "cap"; }
  const open = document.querySelector("dialog[open] .dialog-body");
  (open ?? document.body).append(el);
  el.style.position = open ? "static" : "fixed";
  el.style.transform = open ? "none" : "translateX(-50%)";
  el.textContent = t;
}, text);
const wait = (ms) => page.waitForTimeout(ms);
const drag = async (id, from, to, ms = 1200) => {
  const b = await page.locator("#" + id).boundingBox();
  const y = b.y + b.height / 2;
  await page.mouse.move(b.x + b.width * from, y);
  await page.mouse.down();
  const steps = Math.round(ms / 40);
  for (let i = 1; i <= steps; i++) { await page.mouse.move(b.x + b.width * (from + ((to - from) * i) / steps), y); await wait(40); }
  await page.mouse.up();
};

await cap("PetVoice Lab：声音全部由物理声道模型在本地实时合成（演示里的人声是合成语音）");
await wait(1800);
// first touch starts the audio; start capturing the page's own sound right away
await page.mouse.click(430, 420);
await page.waitForFunction(() => window.__pv.audio.running);
const audioStart = Date.now();
await page.evaluate(() => {
  const tap = window.__pv.audio.recordingStream();
  const rec = new MediaRecorder(tap.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 160000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  window.__demoStop = () => new Promise((res) => { rec.onstop = async () => { const a = new Uint8Array(await new Blob(chunks).arrayBuffer()); let s = ""; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); res(btoa(s)); }; rec.stop(); });
  rec.start(200);
});
await cap("点一下，它就叫");
await wait(600);
await page.mouse.click(430, 420);
await wait(1500);
await cap("捏：从一张图卡开始，比如小奶猫");
await page.locator('#presets button[data-id="kitten"]').click();
await wait(1700);
await cap("拖滑杆改个头：拖动时一直在叫，声道实时变长");
await drag("size", 0.3, 0.92, 1500);
await wait(1300);
await cap("也可以直接拖它的鼻子：口鼻变长，声道跟着变长");
{
  const nose = await page.evaluate(() => window.__pv.fx.hit.nose);
  await page.mouse.move(nose[0], nose[1]);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) { await page.mouse.move(nose[0] + i * 4, nose[1]); await wait(40); }
  await page.mouse.up();
}
await wait(1300);
await cap("年纪：声带和声道一起长大，音高降下来");
await drag("age", 0.07, 0.6, 1300);
await wait(1200);
await cap("叫：在心情轮盘上选“生气”，气更足、声带压紧");
await page.locator("#tab-call").click();
await page.locator('#mood button[data-v="angry"]').click();
await wait(2700);
await cap("点“透视”看里面：呼噜是约 25 Hz 的声门脉冲，黄点是气流方向");
await page.locator("#xray").click();
await page.locator('#calls button[data-id="purr"]').click();
await wait(2600);
await page.locator("#xray").click();
await cap("换回撒娇，起名“团子”，生成声纹卡片");
await page.locator('#mood button[data-v="coax"]').click();
await page.locator("#name").fill("团子");
await wait(1200);
await page.locator("#export-open").click();
  await page.locator("#make-card").click();
await page.waitForFunction(() => document.getElementById("card-status").textContent.includes("链接"));
await cap("声纹卡片：可存 PNG，参数全在链接里");
await wait(2600);
await page.locator("#card-close").click();

await cap("用真实叫声自动捏：上传一段大狗的吠叫（这里用的是合成的），个头自动到位");
await page.locator("#tab-sculpt").click();
await page.locator('#species button[data-v="dog"]').click();
await wait(900);
await page.locator("#fit-open").click();
await page.locator("#fit-call").selectOption("bark");
await page.locator("#fit-file").setInputFiles(resolve("out/fit-bigdog-bark.wav"));
await page.waitForFunction(() => !document.getElementById("fit-undo").hidden);
await wait(3000);
await page.locator("#fit-close").click();
await page.locator('#species button[data-v="cat"]').click();
await page.locator('#presets button[data-id="orange"]').click();
await page.locator("#name").fill("团子");
await wait(1200);
await cap("说：对麦克风说一句问句，它用同样的语气叫");
await page.locator("#tab-talk").click();
await page.locator("#rec").click();
const micStart = Date.now();
await wait(2500);
await page.locator("#rec").click();
await page.waitForFunction(() => !!window.__pv.talk);
await cap("问句 “You want to go outside?”：句尾上扬，团子的叫声也上扬");
await wait(3600);
await cap("也可以打字：英文由合成人声念出来，团子再学（陈述句，句尾下降）");
await page.locator("#say-text").fill("Dinner is ready.");
await page.locator("#say-go").click();
await page.waitForFunction(() => window.__pv.talk?.source === "speech");
await wait(2600);
await cap("中文打字：按标点生成语调（没有人声），问号结尾上扬");
await page.locator("#say-text").fill("你饿不饿？");
await page.locator("#say-text").press("Enter");
await page.waitForFunction(() => window.__pv.talk?.source === "rule");
await wait(2400);
await cap("一键导出竖屏短视频（实时录制：原声 + 叫声 + 剖面动画）");
await page.locator("#export-open").click();
await page.locator("#export-video").click();
await page.waitForFunction(() => !document.getElementById("video-save").hidden || document.getElementById("video-status").textContent.includes("失败"), null, { timeout: 40000 });
await cap("导出完成，可保存或分享");
await wait(1800);
const status = await page.locator("#video-status").textContent();
const b64 = await page.evaluate(() => window.__demoStop());
const total = (Date.now() - videoStart) / 1000;
await ctx.close();
await browser.close();
writeFileSync(`${tmp}/page-audio.webm`, Buffer.from(b64, "base64"));
const video = readdirSync(tmp).find((f) => f.endsWith(".webm") && f !== "page-audio.webm");
renameSync(`${tmp}/${video}`, `${tmp}/screen.webm`);
const aOff = Math.round(audioStart - videoStart);
const mOff = Math.round(micStart - videoStart) + 150;
console.log(`recorded ${total.toFixed(1)} s; page audio starts at ${aOff} ms, microphone clip at ${mOff} ms; export said: ${status}`);
execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", `${tmp}/screen.webm`, "-i", `${tmp}/page-audio.webm`, "-i", mic,
  "-filter_complex", `[1:a]adelay=${aOff}:all=1[a1];[2:a]adelay=${mOff}:all=1,volume=0.8[a2];[a1][a2]amix=inputs=2:normalize=0:duration=longest[a]`,
  "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p", "-r", "25", "-c:a", "aac", "-b:a", "160k", "-t", String(Math.ceil(total)), "-movflags", "+faststart", "demo/demo.mp4"]);
console.log("wrote demo/demo.mp4");
