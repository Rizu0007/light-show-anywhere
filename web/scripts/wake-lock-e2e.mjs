#!/usr/bin/env node
// Wake lock in headless Chrome with a stand-in lock: taken on join, again after a screen lock
// (once), released on leaving. Needs `npm run dev`.

import { chromeSession } from "./chrome.mjs";

const APP = process.env.APP ?? "http://localhost:5173";
if (APP.startsWith("https:")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const EXPECTED = [
  { step: "joined", awake: true, held: 1 },
  { step: "screen locked", awake: false, held: 0 },
  { step: "page back", awake: true, held: 1 },
  { step: "repeated events", awake: true, held: 1 },
  { step: "left the party", awake: false, held: 0 },
  { step: "browser refuses", awake: false, held: 0 },
];

const chrome = await chromeSession();
try {
  const page = await chrome.openPage(`${APP}/`);
  await new Promise((r) => setTimeout(r, 1500));
  const steps = await page.evaluate(`(async () => {
    const { keepAwake } = await import("/src/party/wakeLock.ts");
    let visibility = "visible";
    Object.defineProperty(document, "visibilityState", { get: () => visibility, configurable: true });
    const held = new Set();
    class Sentinel extends EventTarget {
      released = false;
      async release() {
        if (this.released) return;
        this.released = true;
        held.delete(this);
        this.dispatchEvent(new Event("release"));
      }
    }
    const fake = (request) => Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
    fake(async () => {
      const sentinel = new Sentinel();
      held.add(sentinel);
      return sentinel;
    });
    const tick = () => new Promise((r) => setTimeout(r, 30));
    const visibilityChange = () => document.dispatchEvent(new Event("visibilitychange"));
    const steps = [];
    let awake;
    const note = (step) => steps.push({ step, awake, held: held.size });

    const stop = keepAwake((value) => (awake = value));
    await tick();
    note("joined");
    // Locking the screen hides the page and the browser drops the lock.
    visibility = "hidden";
    for (const sentinel of [...held]) await sentinel.release();
    visibilityChange();
    await tick();
    note("screen locked");
    visibility = "visible";
    visibilityChange();
    await tick();
    note("page back");
    visibilityChange();
    visibilityChange();
    await tick();
    note("repeated events");
    stop();
    await tick();
    note("left the party");

    fake(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    awake = undefined;
    const stopRefused = keepAwake((value) => (awake = value));
    await tick();
    note("browser refuses");
    stopRefused();
    return steps;
  })()`);

  let ok = steps.length === EXPECTED.length;
  for (const [i, want] of EXPECTED.entries()) {
    const got = steps[i];
    const pass = got?.awake === want.awake && got?.held === want.held;
    ok &&= pass;
    console.log(
      `${want.step}: awake ${got?.awake}, locks held ${got?.held} (want ${want.awake}, ${want.held}) ${pass ? "✓" : "✗"}`,
    );
  }
  console.log(ok ? "\nPASS" : "\nFAIL");
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await chrome.close();
}
