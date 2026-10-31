#!/usr/bin/env node
// The car preview in headless Chrome on Tesla's example show: the demo before a show loads, lamps
// lighting the body and ground, doors, mirrors, liftgate and charge port moving on the car, the
// timeline, keyboard shortcuts and the drop overlay; and the exported video drawing the same.
// Needs `npm run dev`.
//   node scripts/car-e2e.mjs <lightshow_example_1.fseq>
// SHOTS=<dir> also saves screenshots there.

import { resolve } from "node:path";
import { browserSession, sleep, until } from "./browser.mjs";

const APP = process.env.APP ?? "http://localhost:5173";
if (APP.startsWith("https:")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const [showPath] = process.argv.slice(2);
if (!showPath) {
  console.error("usage: node scripts/car-e2e.mjs <show.fseq>");
  process.exit(2);
}
const show = `/@fs${resolve(showPath)}`;

let failed = 0;
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};

/** Runs in the page: where a falcon door's outline is, relative to the body shell of its picture. */
const FALCON_OUTLINE = `(channel) => [...document.querySelectorAll('[data-falcon="' + channel + '"]')].map((door) => {
  const outline = door.querySelector("path");
  const svg = door.ownerSVGElement;
  const shell = svg.querySelector(".body-shell");
  const toShell = shell.getCTM().inverse().multiply(outline.getCTM());
  const length = outline.getTotalLength();
  const points = Array.from({ length: 60 }, (_, i) => outline.getPointAtLength((i / 60) * length).matrixTransform(toShell));
  return {
    view: svg.getAttribute("aria-label"),
    hidden: points.every((p) => shell.isPointInFill(new DOMPoint(p.x, p.y))),
    top: Math.min(...points.map((p) => p.y)),
  };
})`;

const key = (page, k, target = "window") =>
  page.evaluate(`${target}.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
const time = (page) => page.evaluate(`document.querySelector(".time").textContent.split(" / ")[0]`);
const button = (page) => page.evaluate(`document.querySelector("button.play").textContent`);
const opacity = (page, selector) => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => Number(e.style.opacity))`);

const chrome = await browserSession();
try {
  // ---- before a show: the demo
  const empty = await chrome.openPage(APP);
  await until(() => empty.evaluate(`!!document.querySelector(".car-views.idle [data-ch]")`), "the car picture");
  const sample = () => opacity(empty, ".car-views .lit");
  await sleep(300);
  const first = await sample();
  await sleep(1200);
  const second = await sample();
  check("demo: lights are on before a show loads", first.some((o) => o > 0));
  check("demo: they breathe", first.some((o, i) => Math.abs(o - second[i]) > 0.1));
  check("demo: no doors on a Model 3/Y", await empty.evaluate(`!document.querySelector("[data-falcon]")`));
  check("an empty state explains what to drop", await empty.evaluate(`document.body.innerText.includes("Drop a Tesla light show here")`));

  // Dragging files over the page shows where to drop them.
  await empty.evaluate(`(() => {
    const data = new DataTransfer();
    data.items.add(new File(["x"], "lightshow.fseq"));
    document.querySelector(".app").dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: data }));
  })()`);
  check("drop overlay while dragging files", await empty.evaluate(`!!document.querySelector(".drop-overlay")`));
  await empty.evaluate(`document.querySelector(".app").dispatchEvent(new DragEvent("dragleave", { bubbles: true }))`);
  check("…and gone when they leave", await empty.evaluate(`!document.querySelector(".drop-overlay")`));

  // ---- Tesla's example on a Model X
  const page = await chrome.openPage(`${APP}/?show=${show}&vehicle=model-x`);
  await until(() => page.evaluate(`document.body.innerText.includes("frames")`), "the show to load");
  await sleep(300);
  check("the demo stops when a show loads", await page.evaluate(`!document.querySelector(".car-views.idle")`));

  const closed = await page.evaluate(`(${FALCON_OUTLINE})(31).concat((${FALCON_OUTLINE})(32))`);
  check("falcon doors: drawn in both views", closed.length === 4, `${closed.length}`);
  check("falcon doors: hidden behind the body while closed", closed.every((d) => d.hidden), JSON.stringify(closed));

  // Arrow keys jump 5 s: six take the show to 0:30, where the doors, mirrors, liftgate and
  // charge port are open (see the closure panel).
  for (let i = 0; i < 6; i++) await key(page, "ArrowRight");
  await sleep(400);
  check("→ jumps 5 s at a time", (await time(page)) === "0:30", await time(page));

  const open = await page.evaluate(`(${FALCON_OUTLINE})(31).concat((${FALCON_OUTLINE})(32))`);
  check(
    "falcon doors: raised above the roof when open, inside the picture",
    open.every((d) => !d.hidden && d.top < 40 && d.top > 0),
    JSON.stringify(open.map((d) => Math.round(d.top))),
  );
  const mirrors = await page.evaluate(
    `[...document.querySelectorAll("[data-mirror]")].map((m) => Number(m.getAttribute("transform").match(/scale\\(([\\d.]+)/)[1]))`,
  );
  check("mirrors: folded", mirrors.length === 4 && mirrors.every((w) => w < 0.5), mirrors.join(" "));
  const lid = await page.evaluate(`document.querySelector("[data-lid]").getAttribute("transform")`);
  check("liftgate: lifted, cargo light on", lid.startsWith("translate(0 -16)") && (await opacity(page, "[data-lid-light]"))[0] > 0.9, lid);
  check("charge port: open and lit", (await opacity(page, "[data-port-light]"))[0] === 1);
  const openRows = await page.evaluate(`document.querySelectorAll(".closure.open").length`);
  check("closure panel: open closures stand out", openRows >= 6, `${openRows} open`);

  // The exported video draws the same: one frame each, measured where the parts are (view units).
  const bright = (ms, view, box) => page.evaluate(`window.__lsaFrameBrightness(${ms}, "${view}", ${JSON.stringify(box)})`);
  const aboveRoof = [150, 2, 330, 40];
  const shut = await bright(0, "front", aboveRoof);
  const raised = await bright(30000, "front", aboveRoof);
  check("video: falcon doors hidden while closed, raised when open", shut < 25 && raised > 35, `${shut} → ${raised}`);
  const cargo = await bright(30000, "rear", [160, 70, 240, 92]);
  check("video: the cargo light under the lifted liftgate", cargo > 150, `${cargo}`);
  const port = await bright(30000, "rear", [40, 122, 58, 144]);
  check("video: the charge port light", port > 120, `${port}`);
  // At 0:30 the left side repeater (picture right) is lit; nothing above the middle of the car is.
  const pool = await bright(30000, "front", [330, 228, 385, 244]);
  const unlit = await bright(30000, "front", [185, 228, 215, 244]);
  check("video: a lit lamp lights the ground under it", pool > unlit + 40, `${pool} under the lamp, ${unlit} elsewhere`);

  // Lamps light their surroundings: every lit lamp has its bloom and a pool on the ground.
  const lighting = await page.evaluate(`(() => {
    const lit = [...document.querySelectorAll(".car-view [data-ch]")].filter((e) => Number(e.style.opacity) > 0);
    return lit.map((lamp) => {
      const channel = lamp.dataset.ch;
      const svg = lamp.ownerSVGElement;
      const halo = [...svg.querySelectorAll('[data-halo="' + channel + '"]')].map((h) => h.style.opacity);
      const pool = [...svg.querySelectorAll("[data-pool]")].find((p) => p.dataset.pool.split(",").includes(channel));
      return { channel, lamp: lamp.style.opacity, halo, pool: Number(pool?.style.opacity ?? 0) };
    });
  })()`);
  check("some lamps are lit at 0:30", lighting.length > 0, `${lighting.length} lit`);
  check("every lit lamp blooms as brightly", lighting.every((l) => l.halo.includes(l.lamp)), JSON.stringify(lighting));
  check("every lit lamp lights the ground", lighting.every((l) => l.pool > 0));

  const slices = await page.evaluate(`Number(document.querySelector("canvas[data-timeline]").dataset.timeline)`);
  check("timeline: drawn from the show", slices > 100, `${slices} of 240 slices lit`);

  // Shortcuts: Space plays and pauses, Home goes back; typing in a field is left alone.
  await key(page, " ");
  await until(async () => (await button(page)) === "Pause", "Space to play");
  await sleep(1500);
  check("Space plays", (await time(page)) !== "0:30", await time(page));
  await key(page, " ");
  await until(async () => (await button(page)) === "Play", "Space to pause");
  check("Space pauses", true);
  await key(page, "Home");
  await sleep(200);
  check("Home goes back to the start", (await time(page)) === "0:00", await time(page));
  await key(page, " ", `document.querySelector(".layout input[type=number]")`);
  await sleep(200);
  check("Space in a text field does not play", (await button(page)) === "Play");

  if (process.env.SHOTS) {
    await page.evaluate(`window.scrollTo(0, 0)`);
    for (let i = 0; i < 6; i++) await key(page, "ArrowRight");
    await sleep(400);
    await page.screenshot(resolve(process.env.SHOTS, "car-model-x-30s.png"), 1200, 760);
    await empty.screenshot(resolve(process.env.SHOTS, "car-demo.png"), 1200, 760);
  }

  // Another vehicle: no falcon doors on a Model 3/Y.
  const model3 = await chrome.openPage(`${APP}/?show=${show}&vehicle=model-3y&t=30000`);
  await until(() => model3.evaluate(`document.body.innerText.includes("frames")`), "the show to load");
  check("no falcon doors on a Model 3/Y", await model3.evaluate(`!document.querySelector("[data-falcon]")`));
} catch (error) {
  console.error(error);
  failed++;
} finally {
  await chrome.close();
}
console.log(failed ? `\nFAIL (${failed})` : "\nPASS");
process.exitCode = failed ? 1 : 0;
