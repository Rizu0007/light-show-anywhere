/**
 * Crowd layouts: where phones stand (0–1 across and down, as the audience sees it) and which light
 * each place plays. No browser APIs, so scripts/layout-test.mjs runs it in Node.
 */

import { LIGHT_BARS, LIGHT_SPOTS, VIEW_HEIGHT, VIEW_WIDTH, type Shape, type View } from "../car/layout.ts";

/** A place in a layout (lsa-server's `Spot`). */
export interface Spot {
  x: number;
  y: number;
  /** Car of a fleet show, from 1. */
  car: number;
  /** 1-based Tesla channel. */
  channel: number;
}

export interface Place {
  x: number;
  y: number;
}

/** Most places in a layout (lsa-server's MAX_SPOTS). */
export const MAX_SPOTS = 4096;

const centre = (i: number, n: number) => (i + 0.5) / n;

/** `cols` × `rows` places, row by row from the back. */
export function grid(cols: number, rows: number): Place[] {
  return Array.from({ length: rows * cols }, (_, i) => ({ x: centre(i % cols, cols), y: centre(Math.floor(i / cols), rows) }));
}

/** `n` places in a row, left to right. */
export function line(n: number): Place[] {
  return Array.from({ length: n }, (_, i) => ({ x: centre(i, n), y: 0.5 }));
}

/** `n` places in a ring, clockwise from the top. */
export function circle(n: number): Place[] {
  return Array.from({ length: n }, (_, i) => {
    const angle = (2 * Math.PI * i) / n;
    return { x: 0.5 + 0.42 * Math.sin(angle), y: 0.5 - 0.42 * Math.cos(angle) };
  });
}

interface CarLight extends Place {
  channel: number;
}

const middle = (shape: Shape) =>
  shape.kind === "rect" ? { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 } : { x: shape.cx, y: shape.cy };

/** One view of the car picture as points (light bars LED by LED), stretched to fill 0–1. */
export function carLights(view: View, bars: boolean): CarLight[] {
  const points = LIGHT_SPOTS.filter((s) => s.view === view).map((s) => ({ ...middle(s.shape), channel: s.channel }));
  if (bars) {
    for (const bar of LIGHT_BARS.filter((b) => b.view === view)) {
      const step = (bar.x1 - bar.x0) / bar.count;
      for (let i = 0; i < bar.count; i++) points.push({ x: bar.x0 + step * (i + 0.5), y: bar.y + 2, channel: bar.first + i });
    }
  }
  const span = (values: number[], size: number) => {
    const low = Math.min(...values);
    const high = Math.max(...values);
    // A row of lights (no height) stays in the middle instead of dividing by zero.
    return (v: number) => (high - low > size / 100 ? (v - low) / (high - low) : 0.5);
  };
  const toX = span(points.map((p) => p.x), VIEW_WIDTH);
  const toY = span(points.map((p) => p.y), VIEW_HEIGHT);
  return points.map((p) => ({ x: toX(p.x), y: toY(p.y), channel: p.channel }));
}

/** The light of `lights` nearest to (x, y); earlier lights win ties. */
function nearest(lights: CarLight[], x: number, y: number): number {
  let best = lights[0];
  let bestDistance = Infinity;
  for (const light of lights) {
    const distance = (light.x - x) ** 2 + (light.y - y) ** 2;
    if (distance < bestDistance) {
      best = light;
      bestDistance = distance;
    }
  }
  return best.channel;
}

/**
 * Gives each place the light of the car picture nearest to it, so the crowd draws the car. With
 * several cars the layout is split into equal strips, car 1 on the audience's left.
 */
export function mapLights(places: Place[], view: View, cars: number, bars: boolean): Spot[] {
  const lights = carLights(view, bars);
  return places.map(({ x, y }) => {
    const car = Math.min(cars, Math.floor(x * cars) + 1);
    const across = x * cars - (car - 1);
    return { x, y, car, channel: nearest(lights, across, y) };
  });
}
