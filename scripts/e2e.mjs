// End-to-end smoke test against `vite preview`: sound starts, sliders audition, the card renders,
// a (fake-microphone) recording becomes a call, a video exports. Screenshots land in out/.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const url = process.env.PV_URL ?? "http://127.0.0.1:4173/";
const mic = resolve(process.argv[2] ?? "test-audio/question-female.wav");
mkdirSync("out", { recursive: true });
const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${mic}%noloop`, "--autoplay-policy=no-user-gesture-required"],
});
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
for (const view of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844, isMobile: true, hasTouch: true }]) {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: view.width, height: view.height }, deviceScaleFactor: view.name === "phone" ? 2 : 1, isMobile: !!view.isMobile, hasTouch: !!view.hasTouch, permissions: ["microphone"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
  await page.waitForFunction(() => window.__pv);
  await page.waitForTimeout(400);
  check(`${view.name}: no audio before a gesture`, await page.evaluate(() => window.__pv.audio.ctx === null));
  await page.screenshot({ path: `out/e2e-${view.name}-1-load.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${view.name}: no horizontal scroll`, overflow <= 0, `overflow ${overflow}px`);

  // the pet has the part of the window the sheet leaves free
  const free = view.name === "phone" ? { x: view.width * 0.5, y: 260 } : { x: view.width * 0.5, y: view.height * 0.5 };
  // touch → call
  await page.mouse.click(free.x, free.y);
  await page.waitForFunction(() => window.__pv.audio.running && window.__pv.audio.latencyMs > 0, null, { timeout: 8000 });
  const st = await page.evaluate(() => ({ lat: window.__pv.audio.latencyMs, rate: window.__pv.audio.ctx.sampleRate, out: window.__pv.audio.outputLatency() * 1000 }));
  check(`${view.name}: touch → sound under 150 ms`, st.lat < 150, `${st.lat.toFixed(1)} ms (of which output latency ${st.out.toFixed(1)} ms), ${st.rate} Hz`);
  await page.waitForTimeout(350);
  const mid = await page.evaluate(() => { const t = window.__pv.audio.telemetry(); return { rms: t.outRms, jaw: t.frame.jaw, f0: t.f0, glottis: t.glottis }; });
  check(`${view.name}: engine telemetry moves while it calls`, mid.rms > 0.01 && mid.jaw > 0.15, JSON.stringify(mid));
  await page.screenshot({ path: `out/e2e-${view.name}-2-calling.png` });
  await page.waitForTimeout(900);

  // dragging the head turns it (and is not taken for a tap)
  if (!view.hasTouch) {
    const yaw0 = await page.evaluate(() => window.__pv.fx.view.yaw);
    await page.mouse.move(free.x - 200, free.y + 150);
    await page.mouse.down();
    await page.mouse.move(free.x - 110, free.y + 170, { steps: 6 });
    await page.mouse.up();
    const yaw1 = await page.evaluate(() => window.__pv.fx.view.yaw);
    check(`${view.name}: dragging turns the head`, Math.abs(yaw1 - yaw0) > 0.5, `yaw ${yaw0.toFixed(2)} → ${yaw1.toFixed(2)}`);
    await page.mouse.dblclick(free.x - 200, free.y + 150);
    await page.waitForTimeout(1500);
    check(`${view.name}: double-click squares the view again`, Math.abs((await page.evaluate(() => window.__pv.fx.view.yaw)) - yaw0) < 0.01);

    // direct manipulation: pull the nose for a longer muzzle, roll the wheel for size
    const nose = await page.evaluate(() => window.__pv.fx.hit.nose);
    const snout0 = await page.evaluate(() => window.__pv.spec.snout);
    await page.mouse.move(nose[0], nose[1]);
    await page.mouse.down();
    await page.mouse.move(nose[0] + 70, nose[1], { steps: 8 });
    await page.mouse.up();
    const snout1 = await page.evaluate(() => window.__pv.spec.snout);
    check(`${view.name}: pulling the nose lengthens the muzzle`, snout1 > snout0 + 0.1, `口鼻 ${snout0} → ${snout1}`);
    await page.waitForTimeout(900);
    const size0 = await page.evaluate(() => window.__pv.spec.size);
    await page.mouse.move(free.x, free.y);
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(700);
    const size1 = await page.evaluate(() => window.__pv.spec.size);
    check(`${view.name}: the wheel changes its size`, size1 > size0 + 0.1, `个头 ${size0} → ${size1}`);
    await page.waitForTimeout(900);

    // see-through
    await page.locator("#xray").click();
    await page.waitForTimeout(700);
    check(`${view.name}: see-through shows the inside and the numbers`, (await page.evaluate(() => window.__pv.xray)) > 0.9 && (await page.locator("#v-size").textContent()).includes("cm"));
    await page.screenshot({ path: `out/e2e-${view.name}-2c-xray.png` });
    await page.locator("#xray").click();
  }

  if (view.hasTouch) await page.locator("#sculpt-toggle").click();
  await page.locator('#calls button[data-id="trill"]').click();
  await page.waitForTimeout(1400);
  // Adjusting should replay this call, without a held tone while dragging.
  const before = await page.evaluate(() => window.__pv.character.tractLen);
  const box = await page.locator("#size").boundingBox();
  if (view.hasTouch) {
    await page.locator("#size").fill("0.95");
  } else {
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 0; i <= 10; i++) { await page.mouse.move(box.x + box.width * (0.45 + 0.05 * i), box.y + box.height / 2); await page.waitForTimeout(30); }
    const held = await page.evaluate(() => { const t = window.__pv.audio.telemetry(); return t.gate; });
    check(`${view.name}: quiet while dragging`, held < 0.5, `gate ${held.toFixed(2)}`);
    await page.mouse.up();
  }
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => ({ tract: window.__pv.character.tractLen, engineLen: (() => { const t = window.__pv.audio.telemetry(); return t.lenPh + t.lenOr; })() }));
  check(`${view.name}: size slider changes the engine's tract`, after.tract > before + 0.5 && Math.abs(after.engineLen - after.tract) < after.tract * 0.2, `${before.toFixed(1)} → ${after.tract.toFixed(1)} cm, engine ${after.engineLen.toFixed(1)} cm`);
  await page.waitForTimeout(1200);

  check(`${view.name}: adjusting preserves selected call`, await page.locator('#calls [data-id="trill"]').getAttribute("aria-pressed") === "true");
  // dog preset
  await page.locator("#preset-label").click();
  await page.locator('#species button[data-v="dog"]').click();
  await page.waitForTimeout(200);
  await page.locator('#presets button[data-id="big"]').click();
  await page.waitForTimeout(450);
  await page.screenshot({ path: `out/e2e-${view.name}-3-dog.png` });
  await page.waitForTimeout(800);
  await page.locator("#preset-label").click();
  await page.locator('#species button[data-v="cat"]').click();
  await page.locator('#presets button[data-id="orange"]').click();
  await page.waitForTimeout(900);

  // card
  await page.locator("#export-open").click();
  await page.locator("#make-card").click();
  await page.waitForFunction(() => document.getElementById("card-status").textContent.includes("链接"), null, { timeout: 15000 });
  const png = await page.evaluate(() => document.getElementById("card").toDataURL("image/png"));
  writeFileSync(`out/e2e-${view.name}-card.png`, Buffer.from(png.split(",")[1], "base64"));
  check(`${view.name}: card renders and URL carries the pet`, png.length > 50000 && (await page.evaluate(() => location.hash.startsWith("#pet-cat-"))), `${(png.length / 1e3) | 0} kB`);
  await page.locator("#card-close").click();

  // three tabs, one pane at a time
  await page.locator("#tab-call").click();
  check(`${view.name}: calls and voice parameters share the screen`, (await page.locator("#mood").isVisible()) && (await page.locator("#calls").isVisible()) && (await page.locator("#size").isVisible()));
  await page.locator('#mood button[data-v="sleepy"]').click();
  await page.waitForTimeout(500);
  check(`${view.name}: picking a mood on the wheel changes the pet`, await page.evaluate(() => window.__pv.spec.mood === "sleepy" && document.getElementById("mood-name").textContent === "困倦"));
  await page.screenshot({ path: `out/e2e-${view.name}-3a-call.png` });
  await page.waitForTimeout(1500);


  // sculpt from its voice: a rendered big dog's bark must pull the size slider up
  if (existsSync("out/fit-bigdog-bark.wav")) {
    await page.locator("#preset-label").click();
    await page.locator('#species button[data-v="dog"]').click();
    await page.locator('#presets button[data-id="mid"]').click();
    await page.waitForTimeout(900);
    const before = await page.evaluate(() => window.__pv.spec.size);
    await page.locator("#fit-open").click();
    await page.locator("#fit-call").selectOption("bark");
    await page.locator("#fit-file").setInputFiles(resolve("out/fit-bigdog-bark.wav"));
    await page.waitForFunction(() => !document.getElementById("fit-undo").hidden || document.getElementById("fit-status").classList.contains("err"), null, { timeout: 15000 });
    const after = await page.evaluate(() => ({ size: window.__pv.spec.size, tract: window.__pv.character.tractLen }));
    check(`${view.name}: a big dog's bark (size 0.9, tract 24.3 cm) sculpts a big dog`, after.size > 0.8 && Math.abs(after.tract - 24.3) < 2.5, `size ${before} → ${after.size}, tract ${after.tract.toFixed(1)} cm; ${await page.locator("#fit-status").textContent()}`);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `out/e2e-${view.name}-3b-fit.png` });
    await page.locator("#fit-undo").click();
    check(`${view.name}: undo restores the sliders`, (await page.evaluate(() => window.__pv.spec.size)) === before);
    await page.locator("#fit-close").click();
    await page.waitForTimeout(600);
    await page.locator("#preset-label").click();
    await page.locator('#species button[data-v="cat"]').click();
    await page.locator('#presets button[data-id="orange"]').click();
    await page.waitForTimeout(800);
  }

  // sound export
  if (view.name === "desktop") {
    // an ASCII name: this headless browser reports any non-ASCII download name as "download",
    // so a Chinese pet name cannot be checked here
    await page.locator("#name").fill("Tuanzi");
    const [d1] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.locator("#export-open").click().then(() => page.locator("#export-call").click())]);
    const p1 = await d1.path();
    check("desktop: one call exports as WAV", d1.suggestedFilename().endsWith(".wav") && statSync(p1).size > 20000 && readFileSync(p1).toString("ascii", 0, 4) === "RIFF", `${d1.suggestedFilename()}, ${statSync(p1).size} bytes`);
    const [d2] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.locator("#export-all").click()]);
    await page.locator("#export-close").click();
    const p2 = await d2.path();
    writeFileSync("out/e2e-calls.zip", readFileSync(p2));
    check("desktop: all calls export as a ZIP", d2.suggestedFilename().endsWith(".zip") && readFileSync(p2).toString("latin1").split(".wav").length - 1 >= 20, `${d2.suggestedFilename()}, ${statSync(p2).size} bytes`);
  }

  // typed sentences: English through the synthetic voice, Chinese by rule
  await page.locator("#tab-talk").click();
  await page.locator("#say-text").fill("Do you want a treat?");
  await page.locator("#say-go").click();
  await page.waitForFunction(() => window.__pv.talk?.source === "speech" || document.getElementById("talk-status").classList.contains("err"), null, { timeout: 30000 });
  check(`${view.name}: typed English is spoken, then mimicked`, await page.evaluate(() => window.__pv.talk?.source === "speech" && !!window.__pv.talk.human), await page.locator("#talk-status").textContent());
  await page.waitForTimeout(2600);
  await page.locator("#say-text").fill("该吃饭了。");
  await page.locator("#say-text").press("Enter");
  await page.waitForFunction(() => window.__pv.talk?.source === "rule", null, { timeout: 8000 });
  check(`${view.name}: typed Chinese gets a rule-made falling tune`, (await page.locator("#talk-status").textContent()).includes("下降"), await page.locator("#talk-status").textContent());
  await page.waitForTimeout(1500);

  // the pet's own call: switch the source, upload a rendered meow, it is mimicked as a pet call
  if (existsSync("out/pet-meow.wav")) {
    await page.locator('#src button[data-v="pet"]').click();
    check(`${view.name}: typing and samples step aside in pet mode`, !(await page.locator("#say-text").isVisible()));
    await page.locator("#file").setInputFiles(resolve("out/pet-meow.wav"));
    await page.waitForFunction(() => window.__pv.talk?.source === "pet" || document.getElementById("talk-status").classList.contains("err"), null, { timeout: 15000 });
    check(`${view.name}: the pet's own call is analysed and mimicked`, await page.evaluate(() => window.__pv.talk?.source === "pet" && !!window.__pv.talk.human), await page.locator("#talk-status").textContent());
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `out/e2e-${view.name}-4b-pet.png` });
    await page.locator('#src button[data-v="human"]').click();
  }

  // record from the fake microphone
  await page.locator("#rec").click();
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `out/e2e-${view.name}-4-recording.png` });
  await page.locator("#rec").click();
  await page.waitForFunction(() => !document.getElementById("play-pet").disabled || document.getElementById("talk-status").classList.contains("err"), null, { timeout: 8000 });
  const status = await page.locator("#talk-status").textContent();
  check(`${view.name}: recording → prosody → call`, await page.evaluate(() => !!window.__pv.talk), status);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `out/e2e-${view.name}-5-talk.png` });
  await page.waitForTimeout(1800);

  const remembered = await page.evaluateHandle(() => window.__pv.talk.prosody);
  const firstPlay = await page.evaluate(() => window.__pv.talkStartedAt);
  await page.locator("#snout").fill("0.82");
  await page.waitForFunction(t => window.__pv.talkStartedAt > t, firstPlay);
  check(`${view.name}: new muzzle replays original phrase`, await page.evaluate(p => window.__pv.talk.prosody === p && window.__pv.spec.snout === 0.82, remembered));
  await page.locator("#auto-replay").uncheck();
  const lastPlay = await page.evaluate(() => window.__pv.talkStartedAt);
  await page.locator("#texture").fill("0.41");
  await page.waitForTimeout(250);
  check(`${view.name}: replay switch silences adjustments`, await page.evaluate(t => window.__pv.talkStartedAt === t, lastPlay));
  await page.locator("#tab-call").click();
  await page.locator("#tab-talk").click();
  await page.locator("#start-hint").click();
  await page.waitForFunction(t => window.__pv.talkStartedAt > t, lastPlay);
  check(`${view.name}: stage replays phrase after mode switch`, await page.evaluate(p => window.__pv.talk.prosody === p, remembered));

  // video
  if (view.name === "desktop") {
    const [d3] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.locator("#export-open").click().then(() => page.locator("#export-talk").click())]);
    check("desktop: the mimicked call exports as WAV", d3.suggestedFilename().endsWith("-says.wav") && statSync(await d3.path()).size > 20000, d3.suggestedFilename());
    await page.locator("#export-video").click();
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `out/e2e-${view.name}-6-video-recording.png` });
    await page.waitForFunction(() => !document.getElementById("video-save").hidden || document.getElementById("video-status").textContent.includes("失败"), null, { timeout: 40000 });
    const vs = await page.locator("#video-status").textContent();
    const data = await page.evaluate(async () => { const b = window.__pvVideo; if (!b) return null; const a = new Uint8Array(await b.arrayBuffer()); let s = ""; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return { b64: btoa(s), type: b.type }; });
    if (data) writeFileSync(`out/e2e-video.${data.type.includes("mp4") ? "mp4" : "webm"}`, Buffer.from(data.b64, "base64"));
    check(`${view.name}: video exports`, !!data && data.b64.length > 100000, vs);
    await page.locator("#video-close").click();
  }
  check(`${view.name}: no page errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
}
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
