#!/usr/bin/env node
// The host's crowd-layout editor in headless Chrome: make a layout, add and delete places, keep it
// across reloads, and light the places while the show plays. Needs `npm run dev`.
//   node scripts/layout-e2e.mjs <show.fseq>

import { resolve } from "node:path";
import { browserSession, sleep, until } from "./browser.mjs";

const APP = process.env.APP ?? "http://localhost:5173";
if (APP.startsWith("https:")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const [showPath] = process.argv.slice(2);
if (!showPath) {
  console.error("usage: node scripts/layout-e2e.mjs <show.fseq>");
  process.exit(2);
}

let failed = 0;
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};

const chrome = await browserSession();
try {
  const page = await chrome.openPage(`${APP}/?show=/@fs${resolve(showPath)}`);
  const places = () => page.evaluate(`document.querySelectorAll(".layout-view .place").length`);
  const click = (text) =>
    page.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent === ${JSON.stringify(text)}).click()`);
  await until(() => page.evaluate(`document.body.innerText.includes("frames")`), "the show to load");
  await page.evaluate(`localStorage.removeItem("lsa.layout")`);

  await click("Make layout");
  await until(places, "the layout to appear");
  check("Make layout: the default 8 × 4 grid", (await places()) === 32, `${await places()} places`);

  // Double-click adds a place where the click is; Delete removes the selected one.
  await page.evaluate(`(() => {
    const svg = document.querySelector(".layout-view");
    const box = svg.getBoundingClientRect();
    svg.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: box.left + 5, clientY: box.top + 5 }));
  })()`);
  await sleep(100);
  check("double-click adds a place", (await places()) === 33);
  check("the new place is selected", await page.evaluate(`document.body.innerText.includes("Place 33")`));
  await page.evaluate(
    `document.querySelector(".layout-view").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Delete" }))`,
  );
  await sleep(100);
  check("Delete removes it", (await places()) === 32);
  const saved = await page.evaluate(`JSON.parse(localStorage.getItem("lsa.layout")).length`);
  check("the layout is remembered", saved === 32, `${saved} saved`);

  // Playing lights the places.
  await click("Play");
  const lit = await until(
    () =>
      page.evaluate(
        `[...document.querySelectorAll(".layout-view .lit")].filter((c) => Number(c.style.opacity) > 0).length`,
      ),
    "places to light up",
    20000,
  ).catch(() => 0);
  check("places light up while the show plays", lit > 0, `${lit} lit`);
  await click("Pause");

  await click("Use the car shape");
  await sleep(100);
  check("back to the car shape", (await places()) === 0);
} catch (error) {
  console.error(error);
  failed++;
} finally {
  await chrome.close();
}
console.log(failed ? `\nFAIL (${failed})` : "\nPASS");
process.exitCode = failed ? 1 : 0;
