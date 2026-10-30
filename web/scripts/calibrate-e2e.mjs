#!/usr/bin/env node
// Calibration in headless Chrome: the host's tones go into a fake microphone, directly and through
// a known 200 ms delay. Needs `npm run dev`.

import { browserSession } from "./browser.mjs";

const APP = process.env.APP ?? "http://localhost:5173";
if (APP.startsWith("https:")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const ADDED_MS = 200;
/** One render block plus margin; CI (no sound card, ±12 ms jitter) raises it. */
const MAX_ERROR_MS = Number(process.env.CALIBRATE_MAX_ERROR_MS ?? 3.5);
/** The direct path only crosses from one audio context to another. */
const MAX_DIRECT_MS = 60;

const chrome = await browserSession(["--autoplay-policy=no-user-gesture-required"]);
try {
  const page = await chrome.openPage(`${APP}/`);
  await new Promise((r) => setTimeout(r, 1500));
  const results = await page.evaluate(`(async () => {
    const { playTones, listenForTones } = await import("/src/party/calibrate.ts");
    const host = new AudioContext();
    const phone = new AudioContext();
    const now = () => performance.now();
    const results = [];
    for (const delayMs of [0, ${ADDED_MS}, 0, ${ADDED_MS}]) {
      const delay = host.createDelay(1);
      delay.delayTime.value = delayMs / 1000;
      const microphone = host.createMediaStreamDestination();
      delay.connect(microphone);
      navigator.mediaDevices.getUserMedia = async () => microphone.stream;
      // Both contexts are new, so the first round waits for their clocks to settle (calibrate.ts).
      const request = { at: now() + 3000, tones: 5, gapMs: 700 };
      const [heard] = await Promise.all([
        listenForTones(phone, now, request),
        playTones(host, now, request, delay),
      ]);
      results.push({ delayMs, heard });
      delay.disconnect();
    }
    return results;
  })()`);

  let ok = results.every((r) => r.heard !== null);
  for (const r of results) console.log(`added ${r.delayMs} ms → measured ${r.heard?.toFixed(2) ?? "nothing"} ms`);
  const direct = results.filter((r) => r.delayMs === 0).map((r) => r.heard);
  const delayed = results.filter((r) => r.delayMs === ADDED_MS).map((r) => r.heard);
  for (let i = 0; ok && i < direct.length; i++) {
    const added = delayed[i] - direct[i];
    const pass = Math.abs(added - ADDED_MS) <= MAX_ERROR_MS && Math.abs(direct[i]) <= MAX_DIRECT_MS;
    console.log(`round ${i + 1}: delay added ${added.toFixed(2)} ms (want ${ADDED_MS} ± ${MAX_ERROR_MS}) ${pass ? "✓" : "✗"}`);
    ok &&= pass;
  }
  console.log(ok ? "\nPASS" : "\nFAIL");
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await chrome.close();
}
