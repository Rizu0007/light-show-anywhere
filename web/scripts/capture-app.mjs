#!/usr/bin/env node
// Screenshots of the real app for the demo video's walkthrough: the host page (empty, show loaded,
// party started, phones joined) and a phone (join page, joined, lit). Needs lsa-server, `npm run dev`
// and the Tesla example show (../scripts/fetch-tesla-example.sh).
//   node scripts/capture-app.mjs [output folder]

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserSession, sleep, until } from "./browser.mjs";

const APP = process.env.APP ?? "http://localhost:5173";
const root = fileURLToPath(new URL("../..", import.meta.url));
const example = `${root}shows/tesla/lightshow_example_1_elevator_music/lightshow_example_1_elevator_music`;
const out = resolve(process.argv[2] ?? `${root}media/shots`);
mkdirSync(out, { recursive: true });

const HOST = [1280, 800];
const PHONE = [390, 844];
const shot = async (page, name, [w, h]) => {
  await sleep(400);
  await page.screenshot(join(out, `${name}.png`), w, h);
  console.log(`  ${name}.png`);
};
const click = (text) => `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`;
const scrollTo = (heading) =>
  `(() => { const h = [...document.querySelectorAll("h2,h3,strong")].find((e) => e.textContent.trim().startsWith(${JSON.stringify(heading)})); h.closest("section, div").scrollIntoView({ block: "start" }); window.scrollBy(0, -24); })()`;

const chrome = await browserSession();
try {
  const empty = await chrome.openPage(`${APP}/`);
  await until(() => empty.evaluate(`document.body.innerText.includes("Show (.fseq)")`), "the empty page");
  await shot(empty, "host-empty", HOST);

  // Paused at 38.3 s, where most of the car is lit.
  const host = await chrome.openPage(`${APP}/?show=/@fs${example}/lightshow.fseq&song=/@fs${example}/lightshow.wav&t=38300`);
  await until(() => host.evaluate(`document.body.innerText.includes("Export video")`), "the show to load");
  await host.evaluate(`window.scrollTo(0, 0)`);
  await shot(host, "host-loaded", HOST);

  await host.evaluate(click("Start party"));
  // Shown only on localhost (testing); at a real party the host opens the network address.
  const hideLocalhostWarning = `document.querySelectorAll("p").forEach((p) => p.textContent.includes("can't reach") && p.remove())`;
  await until(() => host.evaluate(`/Room\\s+[A-Z]/.test(document.body.innerText)`), "the room");
  const room = await host.evaluate(`document.body.innerText.match(/Room\\s+([A-Z ]{4,8})/)[1].replace(/\\s/g, "")`);
  await until(() => host.evaluate(`document.body.innerText.includes("clock synced")`), "the host clock");
  await host.evaluate(`[...document.querySelectorAll("h3")].find((h) => h.textContent.startsWith("Phones")).closest("section").scrollIntoView({ block: "center" })`);
  await host.evaluate(hideLocalhostWarning);
  await shot(host, "host-party", HOST);

  const phone = await chrome.openPage(`${APP}/join?room=${room}`);
  await until(() => phone.evaluate(`document.body.innerText.includes("Join the show")`), "the join page");
  await shot(phone, "phone-join", PHONE);
  await phone.evaluate(click("Join the show"));
  await until(() => phone.evaluate(`document.body.innerText.includes("synced")`), "the phone to sync", 30000);
  await shot(phone, "phone-joined", PHONE);

  const others = [];
  for (let i = 0; i < 5; i++) others.push(await chrome.openPage(`${APP}/join?room=${room}&autojoin=1`));
  await until(() => host.evaluate(`/Phones \\(6\\)/.test(document.body.innerText)`), "six phones in the roster");
  await sleep(6000); // Clocks settle, so the roster shows no warnings.
  await host.evaluate(`[...document.querySelectorAll("h3")].find((h) => h.textContent.startsWith("Phones")).closest("section").scrollIntoView({ block: "center" })`);
  await host.evaluate(hideLocalhostWarning);
  await shot(host, "host-roster", HOST);

  // Play from just before the left main beam (phone 1's light) turns on, and catch it lit.
  await host.evaluate(`(() => { const r = document.querySelector("input[type=range]"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(r, "13300"); r.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await sleep(300);
  await host.evaluate(`document.querySelector("button.play").click()`);
  await until(
    () => phone.evaluate(`(() => { const d = [...document.querySelectorAll("div")].find((e) => e.style.backgroundColor); const m = d && d.style.backgroundColor.match(/\\d+/); return m && Number(m[0]) > 230; })()`),
    "phone 1 to light up",
    10000,
  );
  await shot(phone, "phone-lit", PHONE);
  await host.evaluate(`window.scrollTo(0, 0)`);
  await shot(host, "host-playing", HOST);
  await host.evaluate(click("Pause"));
  await host.evaluate(click("End party"));
} finally {
  await chrome.close();
}
console.log(`saved to ${out}`);
