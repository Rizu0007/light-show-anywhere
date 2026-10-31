#!/usr/bin/env node
// A reloaded host tab takes its party back, in headless Chrome: same room, still playing, and the
// phone's show is not restarted (no new upload). Needs lsa-server and `npm run dev`.
//   node scripts/host-reload-e2e.mjs <show.fseq>

import { resolve } from "node:path";
import { browserSession, sleep, until } from "./browser.mjs";

const APP = process.env.APP ?? "http://localhost:5173";
if (APP.startsWith("https:")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const [showPath] = process.argv.slice(2);
if (!showPath) {
  console.error("usage: node scripts/host-reload-e2e.mjs <show.fseq>");
  process.exit(2);
}

let failed = 0;
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};
const click = (page, text) =>
  page.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent === ${JSON.stringify(text)})?.click()`);
const roomOf = (page) => page.evaluate(`document.querySelector(".room-code")?.textContent?.replace("…", "") || null`);

const chrome = await browserSession();
try {
  const host = await chrome.openPage(`${APP}/?show=/@fs${resolve(showPath)}`);
  await until(() => host.evaluate(`document.body.innerText.includes("frames")`), "the show to load");
  await click(host, "Start party");
  const room = await until(() => roomOf(host), "a room");
  const phone = await chrome.openPage(`${APP}/join?room=${room}&autojoin=1`);
  await until(() => phone.evaluate(`!!window.__lsaTrack && document.body.innerText.includes("· synced")`), "the phone's light");
  const version = await phone.evaluate("window.__lsaTrack.version");
  await until(() => host.evaluate(`document.body.innerText.includes("Connected · clock synced")`), "the host's clock");
  await click(host, "Play");
  await until(() => host.evaluate(`[...document.querySelectorAll("button")].some((b) => b.textContent === "Pause")`), "playing");
  console.log(`room ${room}, phone on show version ${version}, playing`);

  await host.evaluate("location.reload()");
  await sleep(500);
  await until(() => host.evaluate(`document.body.innerText.includes("frames")`), "the show to load again");
  const back = await until(() => roomOf(host), "the room after the reload", 20000).catch(() => null);
  check("the reloaded tab has the same room", back === room, `${back}`);
  await until(() => host.evaluate(`document.body.innerText.includes("Connected")`), "the host to reconnect").catch(() => {});
  const playing = await until(
    () => host.evaluate(`[...document.querySelectorAll("button")].some((b) => b.textContent === "Pause")`),
    "playback state",
  ).catch(() => false);
  check("the show is still playing", !!playing);
  await sleep(1000);
  const after = await phone.evaluate("window.__lsaTrack.version");
  check("the phone's show was not restarted", after === version, `version ${version} → ${after}`);
  check("the phone is still in the party", await phone.evaluate(`!document.body.innerText.includes("Show over")`));
  const phones = await host.evaluate(`document.querySelector(".roster h3")?.textContent ?? ""`);
  check("the host sees the phone", phones.includes("(1)"), phones.trim());
} catch (error) {
  console.error(error);
  failed++;
} finally {
  await chrome.close();
}
console.log(failed ? `\nFAIL (${failed})` : "\nPASS");
process.exitCode = failed ? 1 : 0;
