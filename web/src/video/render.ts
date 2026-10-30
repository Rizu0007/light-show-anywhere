/** Draws one video frame on a canvas: the car from the front and rear (as on the page), or the
 *  crowd layout, with the show's title and a time bar. */

import { BODY, COLORS, INTERIOR, LIGHT_BARS, LIGHT_SPOTS, VIEW_HEIGHT, VIEW_WIDTH, type Shape, type View } from "../car/layout";
import type { Spot } from "../party/layouts";

export const WIDTH = 1280;
export const HEIGHT = 720;

type Context = OffscreenCanvasRenderingContext2D;

export interface Frame {
  /** Channel levels (0–255) of each car, car 1 first. */
  levelsByCar: (Uint8Array | undefined)[];
  /** Car drawn in car mode (0-based). */
  car: number;
  /** Draw the Cybertruck light bars. */
  bars: boolean;
  /** Draw this crowd layout instead of the car. */
  crowd: Spot[] | null;
  title: string;
  timeMs: number;
  durationMs: number;
}

const BACKGROUND = "#05070a";
const MUTED = "#8691a3";

const channelColors = (() => {
  const colors = new Map<number, string>();
  for (const bar of LIGHT_BARS) for (let i = 0; i < bar.count; i++) colors.set(bar.first + i, bar.color);
  for (const spot of LIGHT_SPOTS) if (!colors.has(spot.channel)) colors.set(spot.channel, spot.color);
  return colors;
})();

function shapePath(shape: Shape): Path2D {
  const path = new Path2D();
  if (shape.kind === "rect") path.roundRect(shape.x, shape.y, shape.w, shape.h, shape.r ?? 0);
  else path.ellipse(shape.cx, shape.cy, shape.rx, shape.ry, 0, 0, 2 * Math.PI);
  return path;
}

function roundRect(ctx: Context, r: { x: number; y: number; w: number; h: number; r: number }, fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, r.r);
  ctx.fill();
}

/** A light: a dark lens, then its colour at `level` with a glow. */
function light(ctx: Context, path: Path2D, color: string, level: number) {
  ctx.fillStyle = "#232b37";
  ctx.fill(path);
  if (level <= 0) return;
  ctx.save();
  ctx.globalAlpha = level / 255;
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.fillStyle = color;
  ctx.fill(path);
  ctx.restore();
}

/** One view of the car in view units (400 × 260). */
function drawCar(ctx: Context, view: View, levels: Uint8Array | undefined, bars: boolean) {
  const level = (channel: number) => levels?.[channel - 1] ?? 0;
  ctx.fillStyle = "#151b24";
  ctx.strokeStyle = "#2a3445";
  ctx.lineWidth = 1.5;
  const shell = new Path2D(BODY.shell);
  ctx.fill(shell);
  ctx.stroke(shell);
  // Interior RGB lights the glass, as in the preview.
  const zones = [INTERIOR.display, ...INTERIOR.accents].map((first) => [level(first), level(first + 1), level(first + 2)]);
  const mix = [0, 1, 2].map((c) => Math.max(...zones.map((z) => z[c])));
  const glass = new Path2D(BODY.glass);
  ctx.fillStyle = "#0b1018";
  ctx.fill(glass);
  if (Math.max(...mix) > 0) {
    ctx.save();
    ctx.globalAlpha = 0.15 + (0.45 * Math.max(...mix)) / 255;
    ctx.fillStyle = `rgb(${mix.join(",")})`;
    ctx.fill(glass);
    ctx.restore();
  }
  roundRect(ctx, BODY.bumper, "#1b2230");
  for (const wheel of BODY.wheels) roundRect(ctx, wheel, "#050608");
  if (view === "rear") roundRect(ctx, BODY.plate, "#1b2230");

  for (const spot of LIGHT_SPOTS.filter((s) => s.view === view)) {
    light(ctx, shapePath(spot.shape), spot.color, level(spot.channel));
  }
  if (!bars) return;
  for (const bar of LIGHT_BARS.filter((b) => b.view === view)) {
    const step = (bar.x1 - bar.x0) / bar.count;
    const width = Math.abs(step) * 0.8;
    for (let i = 0; i < bar.count; i++) {
      const path = new Path2D();
      path.rect(bar.x0 + step * (i + 0.5) - width / 2, bar.y, width, 4);
      light(ctx, path, bar.color, level(bar.first + i));
    }
  }
}

function drawCrowd(ctx: Context, spots: Spot[], levelsByCar: (Uint8Array | undefined)[], w: number, h: number) {
  const r = Math.max(4, Math.min(28, (0.3 * Math.min(w, h)) / Math.sqrt(Math.max(1, spots.length))));
  for (const spot of spots) {
    const path = new Path2D();
    path.arc(spot.x * w, spot.y * h, r, 0, 2 * Math.PI);
    const color = channelColors.get(spot.channel) ?? COLORS.white;
    light(ctx, path, color, levelsByCar[spot.car - 1]?.[spot.channel - 1] ?? 0);
  }
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function drawFrame(ctx: Context, frame: Frame) {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const top = 70;
  const bottom = HEIGHT - 60;

  if (frame.crowd && frame.crowd.length > 0) {
    ctx.save();
    ctx.translate(60, top);
    drawCrowd(ctx, frame.crowd, frame.levelsByCar, WIDTH - 120, bottom - top);
    ctx.restore();
  } else {
    // Front and rear side by side, each scaled from view units to half the width.
    const scale = Math.min((WIDTH - 90) / 2 / VIEW_WIDTH, (bottom - top) / VIEW_HEIGHT);
    const views: View[] = ["front", "rear"];
    const y = top + (bottom - top - VIEW_HEIGHT * scale) / 2;
    views.forEach((view, i) => {
      const x = 30 + i * (WIDTH / 2);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      drawCar(ctx, view, frame.levelsByCar[frame.car], frame.bars);
      ctx.restore();
      ctx.fillStyle = MUTED;
      ctx.font = "18px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(view === "front" ? "Front" : "Rear", x + (VIEW_WIDTH * scale) / 2, y + VIEW_HEIGHT * scale + 18);
      ctx.textAlign = "left";
    });
  }

  ctx.fillStyle = "#e6ebf2";
  ctx.font = "600 28px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(frame.title.replace(/\.fseq$/i, ""), 30, 38);
  ctx.fillStyle = MUTED;
  ctx.font = "20px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(`${clock(frame.timeMs)} / ${clock(frame.durationMs)}`, WIDTH - 30, 38);
  ctx.textAlign = "left";
  // Time bar.
  const progress = frame.durationMs > 0 ? Math.min(1, frame.timeMs / frame.durationMs) : 0;
  ctx.fillStyle = "#1d2430";
  ctx.fillRect(30, HEIGHT - 28, WIDTH - 60, 4);
  ctx.fillStyle = "#5aa0ff";
  ctx.fillRect(30, HEIGHT - 28, (WIDTH - 60) * progress, 4);
}
