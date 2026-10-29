#!/usr/bin/env node
// Tests the calibration-tone detector (src/party/chirp.ts) on synthetic recordings:
//   node scripts/chirp-test.mjs

import { chirp, findDelay } from "../src/party/chirp.ts";

const RATE = 48000;
const TONES = 5;
const GAP = 0.7 * RATE;
const FIRST = 0.3 * RATE;

// Repeatable noise.
let seed = 1;
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;

/** A recording with the tones `delayMs` late, plus noise, an echo and a loud repeating hum. */
function record({ delayMs, noise = 0, echo = null, hum = 0, gain = 0.2, tones = TONES }) {
  const tone = chirp(RATE);
  const recording = new Float32Array(FIRST + TONES * GAP + RATE);
  const scheduled = [];
  for (let k = 0; k < TONES; k++) {
    // Scheduled at a fractional sample, as real clocks give.
    const at = FIRST + k * GAP + 0.37;
    scheduled.push(at);
    if (k >= tones) continue;
    const arrive = Math.round(at + (delayMs / 1000) * RATE);
    for (let i = 0; i < tone.length; i++) {
      recording[arrive + i] += gain * tone[i];
      if (echo) recording[arrive + Math.round((echo.ms / 1000) * RATE) + i] += echo.gain * gain * tone[i];
    }
  }
  for (let i = 0; i < recording.length; i++) {
    recording[i] += noise * random() + hum * Math.sin((2 * Math.PI * 3000 * i) / RATE);
  }
  return { recording, scheduled };
}

let failed = 0;
function check(name, options, expectMs) {
  const { recording, scheduled } = record(options);
  const found = findDelay(recording, RATE, scheduled);
  const ok =
    expectMs === null ? found === null : found !== null && Math.abs(found.delayMs - expectMs) <= 0.5;
  if (!ok) failed++;
  const got = found ? `${found.delayMs.toFixed(2)} ms (clarity ${found.clarity.toFixed(0)})` : "not heard";
  console.log(`${ok ? "✓" : "✗"} ${name}: ${got}${expectMs === null ? "" : `, want ${expectMs} ms`}`);
}

check("wired speaker", { delayMs: 12 }, 12);
check("bluetooth speaker", { delayMs: 245 }, 245);
check("clock slightly ahead", { delayMs: -20 }, -20);
check("noisy room (noise louder than the tone)", { delayMs: 180, noise: 0.4 }, 180);
check("louder echo after the direct sound", { delayMs: 90, echo: { ms: 25, gain: 1.6 } }, 90);
check("steady 3 kHz hum", { delayMs: 150, hum: 0.3 }, 150);
check("only two tones reached the mic", { delayMs: 200, tones: 2, noise: 0.05 }, 200);
check("silence", { delayMs: 0, gain: 0, noise: 0.05 }, null);
check("tone far below the noise", { delayMs: 100, gain: 0.002, noise: 0.5 }, null);

console.log(failed ? `\nFAIL (${failed})` : "\nPASS");
process.exitCode = failed ? 1 : 0;
