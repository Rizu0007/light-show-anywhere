#!/usr/bin/env node
// Tests what the car preview animates besides the lamps (src/car/scene.ts): light on the body and
// ground, closure poses, the demo before a show is loaded, and the timeline's shape.
//   node scripts/car-test.mjs

import { LIGHT_BARS, LIGHT_SPOTS, VIEW_WIDTH, VIEW_HEIGHT } from "../src/car/layout.ts";
import {
  FALCON_CLOSED_DEG,
  FALCON_OPEN_DEG,
  GROUND_Y,
  HALOS,
  IDLE_PERIOD_MS,
  activity,
  bodyGlow,
  chargePortLight,
  falconAngle,
  idleLevels,
  lidPose,
  mirrorWidth,
  pools,
  rgbOf,
  windowGlass,
} from "../src/car/scene.ts";

let failed = 0;
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};
const near = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;
const levels = (lit = {}) => {
  const out = new Uint8Array(200);
  for (const [channel, level] of Object.entries(lit)) out[Number(channel) - 1] = level;
  return out;
};

// ---- light on the surroundings
check("a bloom for every lamp", HALOS.length === LIGHT_SPOTS.length);
check(
  "blooms sit on their lamps, inside the picture",
  HALOS.every((h) => h.cx > 0 && h.cx < VIEW_WIDTH && h.cy > 0 && h.cy < VIEW_HEIGHT && h.r >= 14 && h.r <= 44),
);

for (const view of ["front", "rear"]) {
  const lamps = LIGHT_SPOTS.filter((s) => s.view === view).length;
  const plain = pools(view, false);
  check(`${view}: a ground pool per lamp`, plain.length === lamps, `${plain.length} pools, ${lamps} lamps`);
  const withBars = pools(view, true);
  const barLeds = LIGHT_BARS.filter((b) => b.view === view).flatMap((b) => Array.from({ length: b.count }, (_, i) => b.first + i));
  const covered = withBars.slice(lamps).flatMap((p) => p.channels);
  check(
    `${view}: light bars pool every LED once`,
    covered.length === barLeds.length && new Set(covered).size === barLeds.length && barLeds.every((c) => covered.includes(c)),
  );
  check(`${view}: pools are under the car, gains 0–1`, withBars.every((p) => p.cx >= 0 && p.cx <= VIEW_WIDTH && p.gain > 0 && p.gain <= 1));
}
check("main beams throw the biggest pools", pools("front", false).find((p) => p.channels[0] === 1).rx >= Math.max(...pools("front", false).map((p) => p.rx)));
check("the ground is below the car's wheels", GROUND_Y > 230 && GROUND_Y < VIEW_HEIGHT);

const dark = bodyGlow(levels(), "front", false);
check("nothing lit: no glow", dark.intensity === 0);
const brake = bodyGlow(levels({ 25: 255 }), "rear", false);
check("brake light: the rear glows red", brake.intensity > 0 && brake.rgb.join() === rgbOf("#ff2b2b").join(), brake.rgb.join());
check("brake light: the front stays dark", bodyGlow(levels({ 25: 255 }), "front", false).intensity === 0);
const beams = bodyGlow(levels({ 1: 255, 2: 255, 3: 255, 4: 255 }), "front", false);
check("all main beams: full glow, warm white", beams.intensity === 1 && beams.rgb.join() === rgbOf("#fff4dc").join(), `${beams.intensity} ${beams.rgb}`);
const half = bodyGlow(levels({ 1: 128 }), "front", false).intensity;
check("dimmer lamps glow less", half > 0 && half < bodyGlow(levels({ 1: 255 }), "front", false).intensity);
const mixed = bodyGlow(levels({ 13: 255, 5: 255 }), "front", false).rgb;
check("amber and white mix between them", mixed[2] > rgbOf("#ffae1a")[2] && mixed[2] < rgbOf("#fff4dc")[2], mixed.join());
const bar = bodyGlow(levels({ 50: 255 }), "front", true);
check("light bar LEDs glow only when bars are drawn", bar.intensity > 0 && bodyGlow(levels({ 50: 255 }), "front", false).intensity === 0);

// ---- closures
check("mirrors: unfolded when idle, folded when open", mirrorWidth(0) === 1 && near(mirrorWidth(1), 0.3));
check("falcon doors: hidden when closed, raised when open", falconAngle(0) === FALCON_CLOSED_DEG && falconAngle(1) === FALCON_OPEN_DEG && FALCON_OPEN_DEG < 0);
check(
  "poses move steadily from closed to open",
  [0, 0.25, 0.5, 0.75, 1].every((o, i, all) => i === 0 || (mirrorWidth(o) < mirrorWidth(all[i - 1]) && falconAngle(o) < falconAngle(all[i - 1]) && windowGlass(o) < windowGlass(all[i - 1]))),
);
check("poses stay in range past the ends", mirrorWidth(2) === mirrorWidth(1) && falconAngle(-1) === falconAngle(0) && windowGlass(5) === windowGlass(1));
check("windows: closed glass is all up, open glass mostly down", windowGlass(0) === 1 && windowGlass(1) < 0.2);
check("liftgate: still when shut, up and foreshortened when open", lidPose(0).lift === 0 && lidPose(0).height === 1 && lidPose(1).lift > 10 && lidPose(1).height < 0.5);
check("charge port: dark when shut, blue when open", chargePortLight(0) === null && chargePortLight(1) === "#7cc4ff");
const dance = new Set([0.6, 0.7, 0.8, 0.9].map(chargePortLight));
check("charge port: a dancing port cycles colours", dance.size === 4, [...dance].join(" "));

// ---- the demo before a show is loaded
const quiet = idleLevels(0);
const bright = idleLevels(IDLE_PERIOD_MS / 2);
check("demo: the running and tail lights breathe", bright[4] > quiet[4] + 150 && bright[25] > quiet[25] + 150, `${quiet[4]} → ${bright[4]}`);
check("demo: it repeats every period", idleLevels(IDLE_PERIOD_MS).join() === quiet.join());
check("demo: a sweep runs along the light bars", idleLevels(500).slice(46, 106).join() !== idleLevels(1500).slice(46, 106).join());
check("demo: doors, windows and mirrors stay put", idleLevels(1234).slice(30, 46).every((v) => v === 0));
check("demo with reduced motion: steady", idleLevels(0, true).join() === idleLevels(2345, true).join() && idleLevels(0, true)[4] > 0);

// ---- the timeline
const DURATION = 10_000;
// Dark for the first half, then every lamp red... a strobe of 40 ms at 2 s, between samples of a
// whole-show sweep.
const show = (ms) => {
  if (ms >= 2000 && ms < 2040) return levels({ 1: 255 });
  return ms < DURATION / 2 ? levels() : levels(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [i + 1, 255])));
};
const shape = activity(show, DURATION, 100);
check("timeline: one slice per bucket", shape.length === 100);
check("timeline: dark half, busy half", shape.slice(0, 15).every((a) => a.intensity === 0) && shape.slice(55).every((a) => a.intensity === 1));
const redOnly = activity(() => levels({ 25: 255, 26: 255, 27: 255 }), DURATION, 10);
check("timeline: coloured by what is lit", redOnly.every((a) => a.rgb.join() === rgbOf("#ff2b2b").join()), redOnly[0].rgb.join());
const flash = activity((ms) => (ms >= 2000 && ms < 2040 ? levels({ 1: 255 }) : levels()), DURATION, 250, 3);
check("timeline: a 40 ms flash still shows", flash.some((a) => a.intensity > 0));
check("timeline: before a show loads, nothing", activity(() => undefined, DURATION, 20).every((a) => a.intensity === 0));

console.log(failed ? `\nFAIL (${failed})` : "\nPASS");
process.exitCode = failed ? 1 : 0;
