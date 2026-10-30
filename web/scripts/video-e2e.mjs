#!/usr/bin/env node
// Video export in headless Chrome: exports the first seconds of a show with its song, then opens
// the file and checks its tracks, size, length and that the picture follows the show.
// Needs `npm run dev`.
//   node scripts/video-e2e.mjs <show.fseq> <song>

import { resolve } from "node:path";
import { browserSession, until } from "./browser.mjs";

const APP = process.env.APP ?? "http://localhost:5173";
if (APP.startsWith("https:")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const SECONDS = 5;
const [showPath, songPath] = process.argv.slice(2);
if (!showPath || !songPath) {
  console.error("usage: node scripts/video-e2e.mjs <show.fseq> <song>");
  process.exit(2);
}

let failed = 0;
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};

const chrome = await browserSession();
try {
  const page = await chrome.openPage(
    `${APP}/?show=/@fs${resolve(showPath)}&song=/@fs${resolve(songPath)}&exportSeconds=${SECONDS}`,
  );
  await until(() => page.evaluate(`document.body.innerText.includes("Export video")`), "the show to load");
  const started = Date.now();
  await page.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Export video").click()`);
  await until(() => page.evaluate(`!!window.__lsaVideo`), "the export", 120000);
  console.log(`exported ${SECONDS} s in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  const info = await page.evaluate(`window.__lsaInspectVideo(window.__lsaVideo)`);
  console.log(JSON.stringify(info));
  check("a video file", /^video\/(mp4|webm)/.test(info.mimeType), info.mimeType);
  check("1280 × 720", info.width === 1280 && info.height === 720);
  check(`${SECONDS} s long`, Math.abs(info.durationS - SECONDS) < 0.15, `${info.durationS.toFixed(2)} s`);
  check(`${SECONDS * 30} frames`, info.frames === SECONDS * 30, `${info.frames}`);
  check("with the song", !!info.audioCodec, info.audioCodec ?? "no audio track");
  check("the picture follows the show", Math.max(...info.lit) > Math.min(...info.lit), `lit pixels per second: ${info.lit.join(", ")}`);
} catch (error) {
  console.error(error);
  failed++;
} finally {
  await chrome.close();
}
console.log(failed ? `\nFAIL (${failed})` : "\nPASS");
process.exitCode = failed ? 1 : 0;
