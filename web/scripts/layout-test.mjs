#!/usr/bin/env node
// Tests the crowd-layout generators and light mapping (src/party/layouts.ts):
//   node scripts/layout-test.mjs

import { carLights, circle, grid, line, mapLights } from "../src/party/layouts.ts";

let failed = 0;
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};
const inside = (places) => places.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);

const g = grid(3, 2);
check("grid: rows × cols places, back row first", g.length === 6 && g[0].y < g[5].y && g[0].x < g[2].x);
check("line and circle: the asked count, inside the layout", line(7).length === 7 && circle(12).length === 12 && inside([...g, ...line(7), ...circle(12)]));

const front = carLights("front", false);
check("car picture fills 0–1", inside(front) && front.some((l) => l.x === 0) && front.some((l) => l.x === 1));

// Front view: the car's left lights are on the audience's right.
const leftBeam = front.find((l) => l.channel === 1);
const [one] = mapLights([leftBeam], "front", 1, false);
const [mirrored] = mapLights([{ x: 1 - leftBeam.x, y: leftBeam.y }], "front", 1, false);
check("a place on a light plays it", one.channel === 1 && one.car === 1);
check("left and right mirror", mirrored.channel === 2, `got channel ${mirrored.channel}`);

// Two cars: each strip draws a whole car, car 1 on the audience's left.
const [a, b] = mapLights([{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }], "front", 2, false);
const [whole] = mapLights([{ x: 0.5, y: 0.5 }], "front", 1, false);
check("fleet: car 1 left, car 2 right", a.car === 1 && b.car === 2);
check("fleet: each strip is a whole car", a.channel === whole.channel && b.channel === whole.channel);

const [top] = mapLights([{ x: 0.5, y: 0 }], "rear", 1, false);
check("rear view, top middle: high brake light", top.channel === 25, `got channel ${top.channel}`);

// Cybertruck front bar: phones where its LEDs are play one LED each.
const bar = carLights("front", true).filter((l) => l.channel >= 47 && l.channel <= 106);
const onBar = mapLights(bar, "front", 1, true).map((s) => s.channel);
check("front bar: 60 places on the LEDs, 60 LEDs", onBar.every((c, i) => c === bar[i].channel) && new Set(onBar).size === 60);
// A row across the crowd follows the bar in order (car's left is the audience's right), so chases
// cross the crowd; spaced differently from the LEDs, it shares or skips a few.
const row = mapLights(line(60).map((p) => ({ x: p.x, y: bar[0].y })), "front", 1, true)
  .map((s) => s.channel)
  .filter((c) => c >= 47 && c <= 106);
check("front bar: a row follows it in order", row.length >= 50 && row.every((c, i) => i === 0 || c <= row[i - 1]), `${row.length} on the bar`);

console.log(failed ? `\nFAIL (${failed})` : "\nPASS");
process.exitCode = failed ? 1 : 0;
