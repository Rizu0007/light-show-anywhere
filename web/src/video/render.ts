/** Draws one video frame on a canvas: the car from the front and rear (as on the page), or the
 *  crowd layout, with the show's title and a time bar. */

import {
  BODY,
  CHANNEL_COLORS,
  COLORS,
  INTERIOR,
  LIGHT_BARS,
  LIGHT_SPOTS,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  type Shape,
  type View,
} from "../car/layout";
import {
  CLOSURE,
  FALCON,
  GROUND_Y,
  HALOS,
  LID_FRUNK,
  LID_HINGE_Y,
  MIRROR,
  ON_MIRROR,
  PORT,
  SIDE_WINDOW,
  bodyGlow,
  chargePortLight,
  falconAngle,
  lidPose,
  mirrorWidth,
  pools,
  rgbOf,
  windowGlass,
} from "../car/scene";
import type { Vehicle } from "../engine";
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
  /** Which closures the car has (Model X falcon doors, Cybertruck frunk). */
  vehicle: Vehicle;
  /** Draw this crowd layout instead of the car. */
  crowd: Spot[] | null;
  title: string;
  timeMs: number;
  durationMs: number;
}

const BACKGROUND = "#05070a";
const MUTED = "#8691a3";

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

/** `color` at `alpha` (0–1), from `#rrggbb`. */
const rgba = (color: string, alpha: number) => `rgba(${rgbOf(color).join(",")},${alpha})`;

/** A radial glow filling the ellipse at (`cx`, `cy`), as the preview's halo and pool gradients. */
function glow(
  ctx: Context,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  stops: [number, string][],
  alpha: number,
  mode: GlobalCompositeOperation = "screen",
) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.globalCompositeOperation = mode;
  ctx.translate(cx, cy);
  ctx.scale(rx, ry);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();
}

const BODY_PART = { fill: "#1a212d", stroke: "#2c3749" };

function part(ctx: Context, path: Path2D) {
  ctx.fillStyle = BODY_PART.fill;
  ctx.strokeStyle = BODY_PART.stroke;
  ctx.lineWidth = 1;
  ctx.fill(path);
  ctx.stroke(path);
}

/** Runs `draw` on the car's left side (`flip` false) or mirrored to the right. */
function side(ctx: Context, flip: boolean, draw: () => void) {
  ctx.save();
  if (flip) {
    ctx.translate(VIEW_WIDTH, 0);
    ctx.scale(-1, 1);
  }
  draw();
  ctx.restore();
}

function scaleAbout(ctx: Context, px: number, py: number, sx: number, sy: number) {
  ctx.translate(px, py);
  ctx.scale(sx, sy);
  ctx.translate(-px, -py);
}

/** One view of the car in view units (400 × 260), as the page's preview draws it: lamps lighting
 *  the body and ground, and the closures in the show's positions. */
function drawCar(ctx: Context, view: View, levels: Uint8Array | undefined, bars: boolean, vehicle: Vehicle) {
  const level = (channel: number) => levels?.[channel - 1] ?? 0;
  const open = (channel: number) => level(channel) / 255;
  // Front view: the car's left is on the picture's right; rear view: on its left.
  const leftFlip = view === "rear";
  const frunk = vehicle === "cybertruck";

  // The car's shadow on the floor darkens, so it is drawn normally rather than screened.
  glow(ctx, 200, GROUND_Y - 4, 190, 14, [[0, "rgba(0,0,0,0.85)"], [1, "rgba(0,0,0,0)"]], 1, "source-over");
  for (const pool of pools(view, bars)) {
    const lit = Math.max(...pool.channels.map(open)) * pool.gain;
    glow(ctx, pool.cx, GROUND_Y, pool.rx, 9, [[0, rgba(pool.color, 0.9)], [1, rgba(pool.color, 0)]], lit);
  }

  if (vehicle === "model-x") {
    for (const [channel, flip] of [[CLOSURE.falconDoor.left, leftFlip], [CLOSURE.falconDoor.right, !leftFlip]] as const) {
      side(ctx, flip, () => {
        ctx.translate(FALCON.pivotX, FALCON.pivotY);
        ctx.rotate((falconAngle(open(channel)) * Math.PI) / 180);
        part(ctx, new Path2D(FALCON.door));
        ctx.fillStyle = "#0b1018";
        ctx.fill(new Path2D(FALCON.glass));
      });
    }
  }

  ctx.fillStyle = "#151b24";
  ctx.strokeStyle = "#2a3445";
  ctx.lineWidth = 1.5;
  const shell = new Path2D(BODY.shell);
  ctx.fill(shell);
  ctx.stroke(shell);
  roundRect(ctx, BODY.bumper, "#1b2230");
  for (const wheel of BODY.wheels) roundRect(ctx, wheel, "#050608");
  if (view === "rear") roundRect(ctx, BODY.plate, "#1b2230");

  // A hint of the lights on the paint.
  const tint = bodyGlow(levels, view, bars);
  if (tint.intensity > 0) {
    ctx.save();
    ctx.clip(shell);
    const color = `#${tint.rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
    glow(ctx, 200, 0.46 * VIEW_HEIGHT, 0.42 * VIEW_WIDTH, 0.42 * VIEW_HEIGHT, [[0, rgba(color, 1)], [1, rgba(color, 0)]], tint.intensity * 0.22);
    ctx.restore();
  }

  // Interior RGB lights the cabin glass, as in the preview.
  const zones = [INTERIOR.display, ...INTERIOR.accents].map((first) => [level(first), level(first + 1), level(first + 2)]);
  const mix = [0, 1, 2].map((c) => Math.max(...zones.map((z) => z[c])));
  const cabinGlass = (path: Path2D) => {
    ctx.fillStyle = "#0b1018";
    ctx.fill(path);
    ctx.strokeStyle = "#233046";
    ctx.lineWidth = 1;
    ctx.stroke(path);
    if (Math.max(...mix) > 0) {
      ctx.save();
      ctx.globalAlpha = 0.15 + (0.45 * Math.max(...mix)) / 255;
      ctx.fillStyle = `rgb(${mix.join(",")})`;
      ctx.fill(path);
      ctx.restore();
    }
  };
  if (view === "front" || frunk) cabinGlass(new Path2D(BODY.glass));

  const windows = view === "front" ? CLOSURE.frontWindow : CLOSURE.rearWindow;
  const windowPath = new Path2D(`M${SIDE_WINDOW.points.split(" ").join(" L")} Z`);
  for (const [channel, flip] of [[windows.left, leftFlip], [windows.right, !leftFlip]] as const) {
    side(ctx, flip, () => {
      ctx.fillStyle = "#0b1018";
      ctx.fill(windowPath);
      const { top, bottom } = SIDE_WINDOW;
      const glassTop = top + (bottom - top) * (1 - windowGlass(open(channel)));
      ctx.save();
      ctx.beginPath();
      ctx.rect(240, glassTop, 80, bottom - glassTop);
      ctx.clip();
      ctx.fillStyle = "#18222f";
      ctx.fill(windowPath);
      ctx.restore();
    });
  }

  const lidShape = view === "rear" && !frunk ? BODY.glass : view === "front" && frunk ? LID_FRUNK : null;
  if (lidShape) {
    const lid = open(CLOSURE.liftgate);
    const path = new Path2D(lidShape);
    if (lid > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, lid * 1.5);
      const cargo = ctx.createLinearGradient(0, 60, 0, 110);
      cargo.addColorStop(0, "#ffd59a");
      cargo.addColorStop(1, "#a8641c");
      ctx.fillStyle = cargo;
      ctx.fill(path);
      ctx.restore();
    }
    const pose = lidPose(lid);
    ctx.save();
    ctx.translate(0, -pose.lift);
    scaleAbout(ctx, 0, frunk ? LID_HINGE_Y.frunk : LID_HINGE_Y.liftgate, 1, pose.height);
    if (frunk) part(ctx, path);
    else cabinGlass(path);
    ctx.restore();
  }

  if (view === "rear") {
    const { x, y, w, h } = PORT;
    roundRect(ctx, { x, y, w, h, r: 2 }, "#06080b");
    const port = open(CLOSURE.chargePort);
    const color = chargePortLight(port);
    if (color) {
      ctx.save();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.globalCompositeOperation = "screen";
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h / 2, 4, 0, 2 * Math.PI);
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    scaleAbout(ctx, x, 0, 1 - 0.85 * port, 1);
    const door = new Path2D();
    door.roundRect(x, y, w, h, 2);
    part(ctx, door);
    ctx.restore();
  }

  const lamp = (spot: (typeof LIGHT_SPOTS)[number]) => {
    const lit = level(spot.channel);
    const halo = HALOS.find((h) => h.view === view && h.channel === spot.channel && Math.abs(h.cx - centreX(spot.shape)) < 0.01);
    light(ctx, shapePath(spot.shape), spot.color, lit);
    if (halo) {
      glow(ctx, halo.cx, halo.cy, halo.r, halo.r, [[0, rgba(spot.color, 0.75)], [0.35, rgba(spot.color, 0.28)], [1, rgba(spot.color, 0)]], lit / 255);
    }
  };
  const lamps = LIGHT_SPOTS.filter((s) => s.view === view);

  for (const [channel, flip, repeater] of [
    [CLOSURE.mirror.left, leftFlip, 21],
    [CLOSURE.mirror.right, !leftFlip, 22],
  ] as const) {
    ctx.save();
    // The mirror is drawn for the car's left; its repeater lamp is already where it belongs.
    side(ctx, flip, () => {
      scaleAbout(ctx, MIRROR.pivotX, MIRROR.pivotY, mirrorWidth(open(channel)), 1);
      part(ctx, new Path2D(MIRROR.stalk));
      const housing = new Path2D();
      const { x, y, w, h, r } = MIRROR.housing;
      housing.roundRect(x, y, w, h, r);
      part(ctx, housing);
      side(ctx, flip, () => lamps.filter((s) => s.channel === repeater).forEach(lamp));
    });
    ctx.restore();
  }

  lamps.filter((s) => !ON_MIRROR.has(s.channel)).forEach(lamp);
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

const centreX = (shape: Shape) => (shape.kind === "rect" ? shape.x + shape.w / 2 : shape.cx);

function drawCrowd(ctx: Context, spots: Spot[], levelsByCar: (Uint8Array | undefined)[], w: number, h: number) {
  const r = Math.max(4, Math.min(28, (0.3 * Math.min(w, h)) / Math.sqrt(Math.max(1, spots.length))));
  for (const spot of spots) {
    const path = new Path2D();
    path.arc(spot.x * w, spot.y * h, r, 0, 2 * Math.PI);
    const color = CHANNEL_COLORS.get(spot.channel) ?? COLORS.white;
    light(ctx, path, color, levelsByCar[spot.car - 1]?.[spot.channel - 1] ?? 0);
  }
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const TOP = 70;
const BOTTOM = HEIGHT - 60;

/** Where a view of the car sits in the frame: its top-left corner and the size of a view unit. */
export function carPlacement(view: View): { x: number; y: number; scale: number } {
  // Front and rear side by side, each scaled from view units to half the width.
  const scale = Math.min((WIDTH - 90) / 2 / VIEW_WIDTH, (BOTTOM - TOP) / VIEW_HEIGHT);
  return {
    x: 30 + (view === "front" ? 0 : WIDTH / 2),
    y: TOP + (BOTTOM - TOP - VIEW_HEIGHT * scale) / 2,
    scale,
  };
}

export function drawFrame(ctx: Context, frame: Frame) {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const top = TOP;
  const bottom = BOTTOM;

  if (frame.crowd && frame.crowd.length > 0) {
    ctx.save();
    ctx.translate(60, top);
    drawCrowd(ctx, frame.crowd, frame.levelsByCar, WIDTH - 120, bottom - top);
    ctx.restore();
  } else {
    const views: View[] = ["front", "rear"];
    views.forEach((view) => {
      const { x, y, scale } = carPlacement(view);
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      drawCar(ctx, view, frame.levelsByCar[frame.car], frame.bars, frame.vehicle);
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
  const progress = frame.durationMs > 0 ? Math.min(1, frame.timeMs / frame.durationMs) : 0;
  ctx.fillStyle = "#1d2430";
  ctx.fillRect(30, HEIGHT - 28, WIDTH - 60, 4);
  ctx.fillStyle = "#5aa0ff";
  ctx.fillRect(30, HEIGHT - 28, (WIDTH - 60) * progress, 4);
}
