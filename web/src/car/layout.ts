/**
 * Where each channel (1-based) is drawn on a generic 400 × 260 car. Shapes are for the car's
 * left side (right of the picture in the front view); the right side mirrors them, channel + 1.
 */

export const VIEW_WIDTH = 400;
export const VIEW_HEIGHT = 260;

export type View = "front" | "rear";

export const COLORS = {
  white: "#fff4dc",
  amber: "#ffae1a",
  red: "#ff2b2b",
  barWhite: "#e9f2ff",
} as const;

/** The car body, the same from the front and the rear (SVG paths and rects in view units). */
export const BODY = {
  shell:
    "M40 150 C40 120 60 104 96 98 L140 60 C150 50 160 46 175 46 L225 46 C240 46 250 50 260 60 L304 98 C340 104 360 120 360 150 L360 196 C360 204 354 210 346 210 L54 210 C46 210 40 204 40 196 Z",
  glass: "M150 62 L250 62 L286 96 L114 96 Z",
  bumper: { x: 70, y: 192, w: 260, h: 10, r: 4 },
  wheels: [
    { x: 58, y: 204, w: 44, h: 26, r: 6 },
    { x: 298, y: 204, w: 44, h: 26, r: 6 },
  ],
  /** Rear view only. */
  plate: { x: 176, y: 164, w: 48, h: 22, r: 3 },
} as const;

export type Shape =
  | { kind: "rect"; x: number; y: number; w: number; h: number; r?: number }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number };

export interface LightSpot {
  /** 1-based Tesla channel number. */
  channel: number;
  view: View;
  shape: Shape;
  color: string;
}

interface LeftSide {
  channel: number;
  view: View;
  shape: Shape;
  color: string;
  /** `true` when the right side uses the same channel (both lights on one output). */
  shared?: boolean;
  /** `false` for lights that exist only once, in the middle. */
  mirrored?: boolean;
}

const rect = (x: number, y: number, w: number, h: number, r = 2): Shape => ({
  kind: "rect",
  x,
  y,
  w,
  h,
  r,
});

const LEFT_SIDE: LeftSide[] = [
  // ---- front (car's left = picture right)
  { channel: 5, view: "front", shape: rect(244, 108, 100, 4), color: COLORS.white }, // signature DRL
  { channel: 3, view: "front", shape: rect(262, 117, 34, 11, 5), color: COLORS.white }, // inner main beam
  { channel: 1, view: "front", shape: rect(300, 117, 34, 11, 5), color: COLORS.white }, // outer main beam
  { channel: 7, view: "front", shape: rect(262, 132, 20, 4), color: COLORS.white }, // channel 4
  { channel: 9, view: "front", shape: rect(285, 132, 20, 4), color: COLORS.white }, // channel 5
  { channel: 11, view: "front", shape: rect(308, 132, 20, 4), color: COLORS.white }, // channel 6
  { channel: 13, view: "front", shape: rect(338, 112, 14, 18, 3), color: COLORS.amber }, // front turn
  { channel: 17, view: "front", shape: rect(244, 132, 14, 4), color: COLORS.white }, // aux park
  { channel: 19, view: "front", shape: rect(356, 136, 8, 10, 2), color: COLORS.amber }, // side marker
  { channel: 21, view: "front", shape: rect(352, 92, 12, 4), color: COLORS.amber }, // side repeater (mirror)
  {
    channel: 15,
    view: "front",
    shape: { kind: "ellipse", cx: 312, cy: 182, rx: 15, ry: 5 },
    color: COLORS.white,
  }, // front fog

  // ---- rear (car's left = picture left)
  { channel: 23, view: "rear", shape: rect(52, 116, 22, 10, 3), color: COLORS.amber }, // rear turn
  { channel: 26, view: "rear", shape: rect(76, 116, 76, 10, 3), color: COLORS.red }, // tail
  { channel: 25, view: "rear", shape: rect(86, 128, 54, 6, 2), color: COLORS.red, shared: true }, // brake
  { channel: 28, view: "rear", shape: rect(128, 150, 26, 6), color: COLORS.white, shared: true }, // reverse
  { channel: 29, view: "rear", shape: rect(100, 150, 24, 6), color: COLORS.red, shared: true }, // rear fog
  { channel: 25, view: "rear", shape: rect(170, 62, 60, 4), color: COLORS.red, mirrored: false }, // high brake
  { channel: 30, view: "rear", shape: rect(176, 160, 48, 3), color: COLORS.white, mirrored: false }, // plate
];

function mirror(shape: Shape): Shape {
  return shape.kind === "rect"
    ? { ...shape, x: VIEW_WIDTH - shape.x - shape.w }
    : { ...shape, cx: VIEW_WIDTH - shape.cx };
}

/** Every exterior light spot for both views. */
export const LIGHT_SPOTS: LightSpot[] = LEFT_SIDE.flatMap((spot) => {
  const left: LightSpot = {
    channel: spot.channel,
    view: spot.view,
    shape: spot.shape,
    color: spot.color,
  };
  if (spot.mirrored === false) return [left];
  const right: LightSpot = {
    ...left,
    channel: spot.shared ? spot.channel : spot.channel + 1,
    shape: mirror(spot.shape),
  };
  return [left, right];
});

/** Cybertruck light bars, drawn LED by LED from `x0` to `x1`. */
export const LIGHT_BARS: {
  name: string;
  first: number;
  count: number;
  view: View;
  x0: number;
  x1: number;
  y: number;
  color: string;
}[] = [
  // Front bar runs from the car's left (picture right) to its right.
  { name: "Front Light Bar", first: 47, count: 60, view: "front", x0: 350, x1: 50, y: 100, color: COLORS.barWhite },
  { name: "Rear Light Bar", first: 111, count: 52, view: "rear", x0: 54, x1: 346, y: 104, color: COLORS.red },
  { name: "Offroad Light Bar", first: 167, count: 6, view: "front", x0: 250, x1: 150, y: 58, color: COLORS.barWhite },
];

/** Colour of every drawn light channel (1-based), light bars LED by LED. */
export const CHANNEL_COLORS: ReadonlyMap<number, string> = (() => {
  const colors = new Map<number, string>();
  for (const bar of LIGHT_BARS) for (let i = 0; i < bar.count; i++) colors.set(bar.first + i, bar.color);
  for (const spot of LIGHT_SPOTS) if (!colors.has(spot.channel)) colors.set(spot.channel, spot.color);
  return colors;
})();

const range = (first: number, count: number) => Array.from({ length: count }, (_, i) => first + i);

/** Lights a phone or a layout place can play: the 30 exterior lights, then each Cybertruck light
 *  bar LED by LED when the show has them. */
export function lightGroups(bars: boolean): { name: string | null; channels: number[] }[] {
  const lights = { name: bars ? "Lights" : null, channels: range(1, 30) };
  if (!bars) return [lights];
  return [lights, ...LIGHT_BARS.map((bar) => ({ name: bar.name, channels: range(bar.first, bar.count) }))];
}

/** Interior RGB zones: first channel of each R,G,B triple. */
export const INTERIOR = {
  display: 176,
  accents: [179, 182, 185, 188, 191],
};

/** Closures shown in the status panel, in channel order (31–46). */
export const CLOSURE_CHANNELS = range(31, 16);
