/**
 * What the car preview animates besides the lamps themselves: light spilling onto the body and
 * the ground, moving closures, the demo shown before a show is loaded, and the show timeline. No
 * browser APIs, so scripts/car-test.mjs runs it in Node.
 */

import { CHANNEL_COLORS, LIGHT_BARS, LIGHT_SPOTS, type Shape, type View } from "./layout.ts";

/** Where the wheels meet the ground, in view units. */
export const GROUND_Y = 236;

/** Main beams (channels 1–4) throw much more light than the other lamps. */
const BEAMS = new Set([1, 2, 3, 4]);

const centre = (shape: Shape) =>
  shape.kind === "rect"
    ? { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2, w: shape.w, h: shape.h }
    : { x: shape.cx, y: shape.cy, w: shape.rx * 2, h: shape.ry * 2 };

const clamp = (v: number, low: number, high: number) => Math.min(high, Math.max(low, v));

/** A soft bloom around a lamp. */
export interface Halo {
  channel: number;
  view: View;
  cx: number;
  cy: number;
  r: number;
  color: string;
}

/** Bloom around every lamp, bigger for bigger lamps. */
export const HALOS: Halo[] = LIGHT_SPOTS.map(({ channel, view, shape, color }) => {
  const c = centre(shape);
  return { channel, view, cx: c.x, cy: c.y, r: clamp(Math.max(c.w, c.h) / 2 + 12, 14, 44), color };
});

/** Light a group of lamps throws on the ground under the car; brightest of `channels`, times
 *  `gain`. */
export interface Pool {
  channels: number[];
  view: View;
  cx: number;
  rx: number;
  color: string;
  gain: number;
}

/** LEDs of a light bar that share one pool on the ground. */
const BAR_POOL_LEDS = 10;

/** Ground pools for one view: one per lamp, and one per stretch of light bar. */
export function pools(view: View, bars: boolean): Pool[] {
  const lamps: Pool[] = LIGHT_SPOTS.filter((s) => s.view === view).map(({ channel, shape, color }) => {
    const c = centre(shape);
    const beam = BEAMS.has(channel);
    return {
      channels: [channel],
      view,
      cx: c.x,
      rx: beam ? 90 : clamp(c.w * 1.3 + 10, 16, 80),
      color,
      gain: beam ? 0.85 : 0.5,
    };
  });
  if (!bars) return lamps;
  const strips = LIGHT_BARS.filter((b) => b.view === view).flatMap((bar) => {
    const step = (bar.x1 - bar.x0) / bar.count;
    return Array.from({ length: Math.ceil(bar.count / BAR_POOL_LEDS) }, (_, k) => {
      const first = k * BAR_POOL_LEDS;
      const count = Math.min(BAR_POOL_LEDS, bar.count - first);
      return {
        channels: Array.from({ length: count }, (_, i) => bar.first + first + i),
        view,
        cx: bar.x0 + step * (first + count / 2),
        rx: Math.abs(step) * count * 0.8 + 6,
        color: bar.color,
        gain: 0.4,
      };
    });
  });
  return [...lamps, ...strips];
}

/** `#rrggbb` to numbers. */
export function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The colour of everything lit together, and how strongly it lights its surroundings (0–1). */
export interface Glow {
  rgb: [number, number, number];
  intensity: number;
}

/** Lamp area that lights the surroundings fully: about both main beams and the signature lights. */
const FULL_GLOW_AREA = 1400;

/** How the lamps of `view` light the car body: their colours mixed by brightness and size. */
export function bodyGlow(levels: ArrayLike<number> | undefined, view: View, bars: boolean): Glow {
  const lit: { color: string; weight: number }[] = [];
  if (!levels) return mix(lit, FULL_GLOW_AREA);
  for (const { channel, shape, color } of LIGHT_SPOTS.filter((s) => s.view === view)) {
    const c = centre(shape);
    const weight = ((levels[channel - 1] ?? 0) / 255) * Math.max(30, c.w * c.h) * (BEAMS.has(channel) ? 3 : 1);
    if (weight > 0) lit.push({ color, weight });
  }
  if (bars) {
    for (const bar of LIGHT_BARS.filter((b) => b.view === view)) {
      for (let i = 0; i < bar.count; i++) {
        const weight = ((levels[bar.first + i - 1] ?? 0) / 255) * 12;
        if (weight > 0) lit.push({ color: bar.color, weight });
      }
    }
  }
  return mix(lit, FULL_GLOW_AREA);
}

function mix(lit: { color: string; weight: number }[], full: number): Glow {
  const total = lit.reduce((sum, l) => sum + l.weight, 0);
  if (total <= 0) return { rgb: [0, 0, 0], intensity: 0 };
  const rgb = [0, 0, 0] as [number, number, number];
  for (const { color, weight } of lit) {
    const c = rgbOf(color);
    for (let k = 0; k < 3; k++) rgb[k] += (c[k] * weight) / total;
  }
  return { rgb: rgb.map(Math.round) as [number, number, number], intensity: Math.min(1, total / full) };
}

/** Closure channels (1-based) drawn on the car. */
export const CLOSURE = {
  falconDoor: { left: 31, right: 32 },
  mirror: { left: 35, right: 36 },
  frontWindow: { left: 37, right: 39 },
  rearWindow: { left: 38, right: 40 },
  liftgate: 41,
  chargePort: 46,
} as const;

// Shapes of the moving parts, for the car's left side as seen from the front (picture right);
// the right side and the rear view mirror them across the middle of the picture.

/** Mirror: a stalk and a housing, folding about the pivot where it meets the body. */
export const MIRROR = {
  pivotX: 298,
  pivotY: 97,
  stalk: "M296 95 L334 92 L334 97 L296 100 Z",
  housing: { x: 330, y: 84, w: 36, h: 15, r: 5 },
};

/** Falcon door: an outline and its window, rotating about a hinge on the roof. */
export const FALCON = {
  pivotX: 214,
  pivotY: 50,
  door: "M0 -5 L110 -9 Q118 -9 118 -2 L118 6 Q118 11 111 11 L0 6 Z",
  glass: "M14 -3 L84 -6 L84 3 L14 3 Z",
};

/** Side window beside the windshield (front view) or rear window (rear view); its glass drops
 *  from the top. */
export const SIDE_WINDOW = { points: "252,62 259,61 301,97 288,97", top: 61, bottom: 97 };

/** Charge port on the car's left flank, rear view (picture left); its door hinges at its left. */
export const PORT = { x: 43, y: 126, w: 10, h: 14 };

/** Cybertruck frunk lid, front view. The rear liftgate is the rear window (`BODY.glass`). */
export const LID_FRUNK = "M118 97 L282 97 L298 108 L102 108 Z";
/** Hinge lines of the lids. */
export const LID_HINGE_Y = { liftgate: 62, frunk: 97 };

/** Side repeaters sit on the mirrors (front view), so they fold with them. */
export const ON_MIRROR = new Set([21, 22]);

/** Mirrors fold towards the body: their width as seen from the front or rear (1 = unfolded). */
export const mirrorWidth = (open: number) => 1 - 0.7 * clamp(open, 0, 1);

/** Falcon door angle in degrees from the roof hinge: hidden along the side when closed, a raised
 *  wing when open. */
export const FALCON_CLOSED_DEG = 64;
export const FALCON_OPEN_DEG = -18;
export const falconAngle = (open: number) => FALCON_CLOSED_DEG + (FALCON_OPEN_DEG - FALCON_CLOSED_DEG) * clamp(open, 0, 1);

/** How much of a side window's glass is still up (1 = closed). */
export const windowGlass = (open: number) => 1 - 0.85 * clamp(open, 0, 1);

/** A liftgate or frunk lid swinging up on its hinge: how much of its height is still seen, and how
 *  far it rises (view units). */
export function lidPose(open: number): { height: number; lift: number } {
  const o = clamp(open, 0, 1);
  return { height: 1 - 0.75 * o, lift: 16 * o };
}

/** The charge port light: none while shut, Tesla blue when fully open, and cycling colours on the
 *  way (a dancing port swings back and forth, so it flashes through them, as on the car). */
export function chargePortLight(open: number): string | null {
  if (open < 0.05) return null;
  if (open >= 0.99) return "#7cc4ff";
  return `hsl(${Math.round(open * 720) % 360} 100% 60%)`;
}

/** Breathing period of the demo shown before a show is loaded. */
export const IDLE_PERIOD_MS = 4000;

/**
 * Channel levels for the demo shown before a show is loaded: running and tail lights breathe, a
 * slow sweep runs along the light bars. With `still` (reduced motion) they glow steadily.
 */
export function idleLevels(timeMs: number, still = false): Uint8Array {
  const levels = new Uint8Array(200);
  const breath = still ? 0.6 : 0.5 - 0.5 * Math.cos((2 * Math.PI * timeMs) / IDLE_PERIOD_MS);
  const level = Math.round(30 + 225 * breath);
  for (const channel of [5, 6, 26, 27]) levels[channel - 1] = level;
  for (const bar of LIGHT_BARS) {
    const head = still ? -1 : ((timeMs / IDLE_PERIOD_MS) * bar.count * 2) % (bar.count * 2);
    for (let i = 0; i < bar.count; i++) {
      const distance = Math.abs(i - head);
      levels[bar.first + i - 1] = still ? 90 : Math.round(clamp(255 - distance * 50, 25, 255));
    }
  }
  return levels;
}

/** One slice of the show timeline: how much is lit, and in what colour. */
export interface Activity {
  intensity: number;
  rgb: [number, number, number];
}

/** Lamps fully lit at once that count as a full slice (about a whole car front). */
const FULL_ACTIVITY = 10;

/**
 * The show's shape over time: `buckets` slices, each the busiest of `samples` moments in it, so
 * short flashes still show. Counts every drawn light (lamps and light-bar LEDs).
 */
export function activity(
  levelsAt: (ms: number) => ArrayLike<number> | undefined,
  durationMs: number,
  buckets: number,
  samples = 3,
): Activity[] {
  const channels = [...CHANNEL_COLORS.entries()].map(([channel, color]) => ({ channel, rgb: rgbOf(color) }));
  return Array.from({ length: buckets }, (_, b) => {
    let best: Activity = { intensity: 0, rgb: [0, 0, 0] };
    for (let s = 0; s < samples; s++) {
      const levels = levelsAt(((b + (s + 0.5) / samples) / buckets) * durationMs);
      if (!levels) continue;
      let total = 0;
      const rgb = [0, 0, 0];
      for (const { channel, rgb: c } of channels) {
        const lit = (levels[channel - 1] ?? 0) / 255;
        if (lit <= 0) continue;
        // Bar LEDs are tiny: twelve make one lamp.
        const weight = channel > 30 ? lit / 12 : lit;
        total += weight;
        for (let k = 0; k < 3; k++) rgb[k] += c[k] * weight;
      }
      const intensity = Math.min(1, total / FULL_ACTIVITY);
      if (intensity > best.intensity) {
        best = { intensity, rgb: rgb.map((v) => Math.round(v / total)) as [number, number, number] };
      }
    }
    return best;
  });
}
