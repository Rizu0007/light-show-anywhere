/**
 * The project's demo video: animated scenes explaining the idea, drawn with the real engine (a
 * Tesla show emulated in WebAssembly) and the real car picture, encoded to MP4 with Mediabunny.
 *
 * Development page: http://localhost:5173/demo.html?show=/@fs/<show.fseq>&song=/@fs/<song.wav>
 * plays the animation; `&t=12.5` shows one frame; "Render MP4" downloads the video.
 * scripts/make-demo.mjs renders it headless.
 */

import { BODY, CHANNEL_COLORS, COLORS, LIGHT_SPOTS } from "../car/layout";
import { Show, loadEngine } from "../engine";
import { carLights, grid, mapLights, type Spot } from "../party/layouts";
import { drawFrame } from "../video/render";

const W = 1280;
const H = 720;
const FPS = 30;

const BG = "#05070a";
const TEXT = "#e6ebf2";
const MUTED = "#8691a3";
const ACCENT = "#5aa0ff";
const PANEL = "#0d121a";
const LINE = "#1d2430";

/** Video time (s) at which the show and its song start, and how long they play. */
const SONG_AT = 28;
const SONG_END = 72.5;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Scene {
  start: number;
  end: number;
  /** Step label and heading, top left. */
  step?: string;
  heading?: string;
  draw: (ctx: Ctx, local: number, t: number) => void;
}

// ------------------------------------------------------------------------------------ helpers

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const ease = (x: number) => {
  const v = clamp(x);
  return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2;
};
/** 0 → 1 over `dur` seconds from `from`. */
const ramp = (t: number, from: number, dur = 0.6) => ease((t - from) / dur);

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex: string, a: number) => `rgba(${rgb(hex).join(",")},${a})`;

function text(
  ctx: Ctx,
  s: string,
  x: number,
  y: number,
  o: { size?: number; weight?: number; color?: string; align?: CanvasTextAlign; alpha?: number; font?: string } = {},
) {
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  ctx.fillStyle = o.color ?? TEXT;
  ctx.font = `${o.weight ?? 400} ${o.size ?? 24}px ${o.font ?? "system-ui, -apple-system, sans-serif"}`;
  ctx.textAlign = o.align ?? "left";
  ctx.textBaseline = "middle";
  ctx.fillText(s, x, y);
  ctx.restore();
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function panel(ctx: Ctx, x: number, y: number, w: number, h: number, alpha = 1, border = LINE) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  roundRect(ctx, x, y, w, h, 14);
  ctx.fillStyle = PANEL;
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

/** A phone whose screen shows `color` at `level` (0–255). */
function phone(ctx: Ctx, cx: number, cy: number, w: number, color: string, level: number, alpha = 1) {
  const h = w * 1.8;
  const k = level / 255;
  ctx.save();
  ctx.globalAlpha *= alpha;
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, w * 0.22);
  ctx.fillStyle = "#1a2130";
  ctx.fill();
  const [r, g, b] = rgb(color);
  if (k > 0.05) {
    ctx.shadowColor = `rgba(${r},${g},${b},${0.8 * k})`;
    ctx.shadowBlur = w * 1.4 * k;
  }
  roundRect(ctx, cx - w / 2 + w * 0.1, cy - h / 2 + w * 0.12, w * 0.8, h - w * 0.24, w * 0.14);
  ctx.fillStyle = `rgb(${Math.round(8 + r * k)},${Math.round(10 + g * k)},${Math.round(14 + b * k)})`;
  ctx.fill();
  ctx.restore();
}

type Device = "iphone" | "android" | "tablet" | "fold" | "classic" | "pixel";

/** A real-looking device (screen towards the audience) with its flashlight beam above it. */
function device(ctx: Ctx, kind: Device, cx: number, cy: number, level: number, alpha: number) {
  const size: Record<Device, [number, number, number]> = {
    iphone: [72, 148, 18],
    android: [70, 152, 10],
    tablet: [128, 172, 12],
    fold: [112, 140, 10],
    classic: [62, 124, 12],
    pixel: [68, 146, 14],
  };
  const [w, h, r] = size[kind];
  const k = level / 255;
  const x = cx - w / 2;
  const y = cy - h / 2;
  ctx.save();
  ctx.globalAlpha *= alpha;
  // Flashlight: a beam rising from the top of the phone while the light is on.
  if (k >= 0.5) {
    const beam = ctx.createLinearGradient(0, y, 0, y - 150);
    beam.addColorStop(0, `rgba(255,248,230,${0.5 * k})`);
    beam.addColorStop(1, "rgba(255,248,230,0)");
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(cx - 8, y);
    ctx.lineTo(cx + 8, y);
    ctx.lineTo(cx + 55, y - 150);
    ctx.lineTo(cx - 55, y - 150);
    ctx.closePath();
    ctx.fill();
  }
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = "#1f2736";
  ctx.fill();
  ctx.strokeStyle = "#39445a";
  ctx.lineWidth = 2;
  ctx.stroke();
  const bezel = kind === "classic" ? 6 : 5;
  const top = kind === "classic" ? 18 : bezel;
  const bottom = kind === "classic" ? 22 : bezel;
  if (k > 0.05) {
    ctx.shadowColor = `rgba(255,244,220,${0.9 * k})`;
    ctx.shadowBlur = 50 * k;
  }
  roundRect(ctx, x + bezel, y + top, w - 2 * bezel, h - top - bottom, Math.max(3, r - 5));
  const c = Math.round(10 + 245 * k);
  ctx.fillStyle = `rgb(${c},${Math.round(12 + 232 * k)},${Math.round(16 + 204 * k)})`;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#05070a";
  if (kind === "iphone") {
    roundRect(ctx, cx - 14, y + 10, 28, 8, 4);
    ctx.fill();
  } else if (kind === "android" || kind === "pixel") {
    ctx.beginPath();
    ctx.arc(cx, y + 13, 3.5, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === "classic") {
    ctx.strokeStyle = "#39445a";
    ctx.beginPath();
    ctx.arc(cx, y + h - 11, 6, 0, Math.PI * 2);
    ctx.stroke();
  } else if (kind === "fold") {
    ctx.strokeStyle = `rgba(5,7,10,${0.25 + 0.3 * k})`;
    ctx.beginPath();
    ctx.moveTo(cx, y + bezel);
    ctx.lineTo(cx, y + h - bezel);
    ctx.stroke();
  }
  ctx.restore();
}

function arrow(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, alpha = 1, color = MUTED) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const a = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - 12 * Math.cos(a - 0.45), y2 - 12 * Math.sin(a - 0.45));
  ctx.lineTo(x2 - 12 * Math.cos(a + 0.45), y2 - 12 * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function chip(ctx: Ctx, s: string, x: number, y: number, alpha: number, color = ACCENT, size = 19) {
  ctx.save();
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  const w = ctx.measureText(s).width + 28;
  ctx.globalAlpha *= alpha;
  roundRect(ctx, x, y - size, w, size * 2, size);
  ctx.fillStyle = rgba(color, 0.14);
  ctx.fill();
  ctx.strokeStyle = rgba(color, 0.6);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
  text(ctx, s, x + 14, y, { size, weight: 600, color, alpha });
  return w;
}

/** The app's logo: two lights joined by a line. */
function logo(ctx: Ctx, cx: number, cy: number, s: number, glow: number) {
  ctx.save();
  ctx.strokeStyle = TEXT;
  ctx.lineWidth = s * 0.12;
  ctx.beginPath();
  ctx.moveTo(cx - s, cy);
  ctx.lineTo(cx + s, cy);
  ctx.stroke();
  ctx.shadowColor = COLORS.white;
  ctx.shadowBlur = s * glow;
  ctx.fillStyle = COLORS.white;
  for (const dx of [-s, s]) {
    ctx.beginPath();
    ctx.arc(cx + dx, cy, s * 0.32, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Deterministic pseudo-random numbers, so every render is the same. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function qr(ctx: Ctx, x: number, y: number, size: number) {
  const n = 25;
  const cell = size / n;
  const r = random(7);
  ctx.fillStyle = "#fff";
  roundRect(ctx, x - 10, y - 10, size + 20, size + 20, 8);
  ctx.fill();
  ctx.fillStyle = "#05070a";
  const finder = (fx: number, fy: number) => fx < 7 && fy < 7;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const inFinder = finder(i, j) || finder(n - 1 - i, j) || finder(i, n - 1 - j);
      if (inFinder) {
        const a = i < 7 ? i : n - 1 - i;
        const b = j < 7 ? j : n - 1 - j;
        const ring = a === 0 || a === 6 || b === 0 || b === 6;
        const core = a >= 2 && a <= 4 && b >= 2 && b <= 4;
        if (ring || core) ctx.fillRect(x + i * cell, y + j * cell, cell, cell);
      } else if (r() > 0.52) ctx.fillRect(x + i * cell, y + j * cell, cell, cell);
    }
}

/** The safety governor of lsa-server (safety.rs), ported for the safety scene's picture. */
function luminance(level: number) {
  const c = level / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function govern(levels: number[], step: number): number[] {
  const maxChange = Math.min(255, Math.ceil((255 * step) / 150));
  const recent: number[] = [];
  let level = 0;
  let goal = 0;
  let anchor = 0;
  let rising: boolean | null = null;
  return levels.map((target, frame) => {
    while (recent.length && (frame - recent[0]) * step >= 1000) recent.shift();
    const further = (goal > level && target > goal) || (goal < level && target < goal);
    if (level === goal || further) goal = target;
    const next = goal > level ? Math.min(goal, level + maxChange) : Math.max(goal, level - maxChange);
    const lum = luminance(next);
    const change = rising === null ? Math.abs(lum - anchor) : rising ? anchor - lum : lum - anchor;
    if (change >= 0.1 && Math.min(lum, anchor) < 0.8) {
      if (recent.length < 6) {
        recent.push(frame);
        rising = lum > anchor;
        anchor = lum;
        level = next;
      } else goal = level;
    } else {
      if ((rising === true && lum > anchor) || (rising === false && lum < anchor)) anchor = lum;
      level = next;
    }
    return level;
  });
}

// ------------------------------------------------------------------------------------ the show

let show: Show | null = null;
const empty = new Uint8Array(48);
/** Channel levels the show gives at video time `t`. */
function levels(t: number): Uint8Array {
  if (!show || t < SONG_AT) return empty;
  return show.levelsAt((t - SONG_AT) * 1000) ?? empty;
}
const levelOf = (lv: Uint8Array, channel: number) => lv[channel - 1] ?? 0;
const colorOf = (channel: number) => CHANNEL_COLORS.get(channel) ?? COLORS.white;
/** A gentle idle pulse for scenes before the show starts. */
function idle(t: number, channel: number) {
  const phase = (t * 0.9 + channel * 0.37) % 2;
  return Math.round(255 * Math.max(0, Math.sin(phase * Math.PI)) ** 3);
}

const carCanvas = new OffscreenCanvas(W, H);
const carCtx = carCanvas.getContext("2d")!;
/** The real preview (front and rear) at video time `t`, drawn into the given box. */
function car(ctx: Ctx, t: number, x: number, y: number, w: number, alpha = 1) {
  drawFrame(carCtx, {
    levelsByCar: [levels(t)],
    car: 0,
    bars: false,
    vehicle: "model-3y",
    crowd: null,
    title: "",
    timeMs: 0,
    durationMs: 0,
  });
  const h = (w * 590) / W;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.drawImage(carCanvas, 0, 70, W, 590, x, y, w, h);
  ctx.restore();
}

/** A crowd of phones standing in a layout, each playing its light. */
function crowd(ctx: Ctx, spots: Spot[], lv: (channel: number) => number, x: number, y: number, w: number, h: number, size: number, appear = 1) {
  spots.forEach((s, i) => {
    const shown = clamp(appear * spots.length - i);
    if (shown <= 0) return;
    phone(ctx, x + s.x * w, y + s.y * h + (1 - shown) * 30, size, colorOf(s.channel), lv(s.channel), shown);
  });
}

const CAR_CROWD = mapLights(grid(12, 6), "front", 1, false);

// ------------------------------------------------------------------------------------ narration

/** What the narrator says: [start (s), room before the next line (s), words]. Shown as subtitles;
 *  scripts/make-demo.mjs speaks it. */
export const NARRATION: [number, number, string][] = [
  [0.5, 3.4, "This is Light Show Anywhere, where every phone becomes one light."],
  [4.2, 3.7, "No Tesla? No problem. A crowd of phones becomes the car."],
  [8.3, 4.1, "Here's how it works. Open the app, and drop in a Tesla light show with its song."],
  [12.6, 3.8, "Right away, you see the car play the show. Lights, doors, and all."],
  [16.6, 3.8, "Press Start party, and you get a room code and a QR code."],
  [20.6, 4.3, "Friends scan it, and tap Join. Each phone is handed its own light."],
  [25.1, 2.8, "Then, hit Play."],
  [28.6, 7.2, "Behind the scenes, a Rust engine plays the show exactly like a real Tesla. Every lamp, and every fade."],
  [36.4, 6.4, "Fast strobes are softened before they reach anyone's phone, so the show is safe to watch."],
  [43.4, 6.4, "The server deals out the lights, headlights first, and sends each phone only its own part."],
  [49.9, 7.0, "So when everyone stands together and raises their phone, the crowd becomes the car. Flashlights and all."],
  [57.3, 3.6, "Every phone follows the server's clock, so they all flash together."],
  [61.3, 7.4, "From above, you can see it. A car, drawn by people, playing in time with the music."],
  [69.6, 12.0, "It even measures your speaker's delay, drives LED strips, exports the show as a video, and keeps playing when the Wi-Fi drops."],
  [84.4, 7.0, "Light Show Anywhere. Built with Rust, WebAssembly, and React. Every phone is one light."],
];

// ------------------------------------------------------------------------------------ walkthrough

type Picture = CanvasImageSource & { width: number; height: number };
/** Screenshots of the real app (scripts/capture-app.mjs), by name. */
const shots: Record<string, Picture> = {};
const SHOT_NAMES = ["host-empty", "host-loaded", "host-party", "host-roster", "host-playing", "phone-join", "phone-joined", "phone-lit"];

type Crop = [number, number, number, number];
const lerpCrop = (a: Crop, b: Crop, k: number): Crop => a.map((v, i) => v + (b[i] - v) * k) as Crop;

/** A browser window showing `crop` of a screenshot; returns a mapper from screenshot to screen. */
function browserWindow(ctx: Ctx, name: string, x: number, y: number, w: number, crop: Crop, alpha = 1, url = "localhost:5173") {
  const bar = 34;
  const h = bar + (w * crop[3]) / crop[2];
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 40;
  roundRect(ctx, x, y, w, h, 12);
  ctx.fillStyle = "#151b26";
  ctx.fill();
  ctx.shadowBlur = 0;
  ["#ff5f57", "#febc2e", "#28c840"].forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x + 20 + i * 18, y + bar / 2, 5.5, 0, Math.PI * 2);
    ctx.fill();
  });
  roundRect(ctx, x + w / 2 - 130, y + 8, 260, 19, 9);
  ctx.fillStyle = "#0b1018";
  ctx.fill();
  ctx.restore();
  text(ctx, url, x + w / 2, y + bar / 2 + 1, { size: 13, color: MUTED, align: "center", alpha });
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.beginPath();
  ctx.roundRect(x, y + bar, w, h - bar, [0, 0, 12, 12]);
  ctx.clip();
  const img = shots[name];
  if (img) ctx.drawImage(img, crop[0], crop[1], crop[2], crop[3], x, y + bar, w, h - bar);
  ctx.restore();
  const k = w / crop[2];
  return (sx: number, sy: number) => ({ x: x + (sx - crop[0]) * k, y: y + bar + (sy - crop[1]) * k, k });
}

/** A phone showing a 390 × 844 screenshot; returns a mapper from screenshot to screen. */
function phoneShot(ctx: Ctx, name: string, cx: number, cy: number, h: number, alpha = 1, glow = 0) {
  const screenH = h - 24;
  const screenW = (screenH * 390) / 844;
  const w = screenW + 24;
  ctx.save();
  ctx.globalAlpha *= alpha;
  if (glow > 0) {
    ctx.shadowColor = `rgba(255,244,220,${glow})`;
    ctx.shadowBlur = 90 * glow;
  } else {
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 40;
  }
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 40);
  ctx.fillStyle = "#1f2736";
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "#39445a";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(cx - screenW / 2, cy - screenH / 2, screenW, screenH, 30);
  ctx.clip();
  const img = shots[name];
  if (img) ctx.drawImage(img, cx - screenW / 2, cy - screenH / 2, screenW, screenH);
  ctx.restore();
  ctx.save();
  ctx.globalAlpha *= alpha;
  roundRect(ctx, cx - 30, cy - screenH / 2 + 10, 60, 16, 8);
  ctx.fillStyle = "#05070a";
  ctx.fill();
  ctx.restore();
  const k = screenW / 390;
  return (sx: number, sy: number) => ({ x: cx - screenW / 2 + sx * k, y: cy - screenH / 2 + sy * k });
}

function pointer(ctx: Ctx, x: number, y: number, alpha: number) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 26);
  ctx.lineTo(7, 20);
  ctx.lineTo(12, 31);
  ctx.lineTo(17, 29);
  ctx.lineTo(12, 18);
  ctx.lineTo(21, 18);
  ctx.closePath();
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#05070a";
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** A tap or click: a ring that grows and fades over `p` 0 → 1. */
function ripple(ctx: Ctx, x: number, y: number, p: number) {
  if (p <= 0 || p >= 1) return;
  ctx.save();
  ctx.strokeStyle = rgba(ACCENT, 1 - p);
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(x, y, 10 + 34 * ease(p), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function fileChip(ctx: Ctx, name: string, x: number, y: number, alpha: number, color: string) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 20;
  roundRect(ctx, x - 90, y - 26, 180, 52, 10);
  ctx.fillStyle = "#1b2433";
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = rgba(color, 0.8);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = color;
  roundRect(ctx, x - 78, y - 15, 22, 30, 3);
  ctx.fill();
  ctx.restore();
  text(ctx, name, x - 46, y, { size: 17, weight: 600, alpha });
}

const STEPS = [
  "Step 1 · Drop in a show and its song",
  "Step 2 · Watch the car play it",
  "Step 3 · Start a party",
  "Step 4 · Friends scan and join",
  "Step 5 · Press Play",
];
const STEP_AT = [0, 4.5, 8.5, 12.5, 17];

function walkthrough(ctx: Ctx, l: number) {
  const step = STEP_AT.filter((at) => l >= at).length - 1;
  const sl = l - STEP_AT[step];
  const stepEnd = (STEP_AT[step + 1] ?? 20) - STEP_AT[step];
  const a = Math.min(ramp(sl, 0, 0.4), clamp((stepEnd - sl) / 0.35));
  text(ctx, "HOW TO USE IT", 70, 58, { size: 17, weight: 700, color: ACCENT });
  text(ctx, STEPS[step], 70, 98, { size: 36, weight: 700, alpha: ramp(sl, 0, 0.4) });
  STEPS.forEach((_, i) => {
    ctx.fillStyle = i <= step ? ACCENT : LINE;
    ctx.beginPath();
    ctx.arc(W - 70 - (STEPS.length - 1 - i) * 22, 60, 6, 0, Math.PI * 2);
    ctx.fill();
  });
  const FULL: Crop = [0, 0, 1280, 800];
  if (step === 0) {
    const loaded = ramp(sl, 2.7, 0.5);
    browserWindow(ctx, "host-empty", 250, 130, 780, FULL, a * (1 - loaded));
    browserWindow(ctx, "host-loaded", 250, 130, 780, FULL, a * loaded);
    const fly = ease((sl - 0.8) / 1.6);
    if (sl < 2.8) {
      fileChip(ctx, "lightshow.fseq", 1150 - 560 * fly, 300 + 60 * fly, a * (1 - ramp(sl, 2.5, 0.3)), ACCENT);
      fileChip(ctx, "lightshow.wav", 1180 - 560 * fly, 380 + 20 * fly, a * (1 - ramp(sl, 2.5, 0.3)), COLORS.amber);
    }
    ripple(ctx, 640, 380, (sl - 2.4) / 0.6);
  } else if (step === 1) {
    const zoom = ease((sl - 0.3) / 3);
    browserWindow(ctx, "host-loaded", 250, 130, 780, lerpCrop(FULL, [90, 170, 1100, 688], zoom), a);
  } else if (step === 2) {
    const zoom = ease((sl - 0.6) / 2.2);
    const map = browserWindow(ctx, "host-party", 250, 130, 780, lerpCrop(FULL, [60, 220, 820, 513], zoom), a);
    const qrA = map(120, 286);
    const qrB = map(306, 472);
    const pulse = 0.5 + 0.5 * Math.sin(sl * 5);
    ctx.save();
    ctx.globalAlpha = a * ramp(sl, 2.4, 0.4);
    ctx.strokeStyle = rgba(COLORS.amber, 0.6 + 0.4 * pulse);
    ctx.lineWidth = 4;
    roundRect(ctx, qrA.x - 10, qrA.y - 10, qrB.x - qrA.x + 20, qrB.y - qrA.y + 20, 12);
    ctx.stroke();
    ctx.restore();
  } else if (step === 3) {
    const joined = ramp(sl, 2.3, 0.35);
    const ph = phoneShot(ctx, "phone-join", 300, 400, 500, a * (1 - joined));
    phoneShot(ctx, "phone-joined", 300, 400, 500, a * joined);
    const btn = ph(195, 627);
    pointer(ctx, btn.x + 40 * (1 - ease(sl / 1.8)), btn.y + 60 * (1 - ease(sl / 1.8)), a * (1 - ramp(sl, 2.6, 0.3)));
    ripple(ctx, btn.x, btn.y, (sl - 1.9) / 0.6);
    // The host's list fills in as phones join.
    const rows = Math.floor(ramp(sl, 2.4, 1.6) * 6);
    const crop: Crop = [740, 270, 470, 290];
    const map = browserWindow(ctx, "host-roster", 560, 195, 640, crop, a * ramp(sl, 0.4));
    const top = map(0, 313).y;
    const bottom = map(0, 313 + 34 * 6).y;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = "#0b0f15";
    const coverFrom = top + ((bottom - top) * rows) / 6;
    ctx.fillRect(map(740, 0).x, coverFrom, 640, Math.max(0, bottom - coverFrom + 6));
    ctx.restore();
    text(ctx, "The host sees every phone and its light", 880, 170, { size: 20, color: MUTED, align: "center", alpha: a * ramp(sl, 1) });
  } else {
    const lit = ramp(sl, 1.3, 0.25);
    const map = browserWindow(ctx, "host-playing", 120, 160, 700, [0, 0, 1280, 800], a);
    const play = map(130, 620);
    pointer(ctx, play.x + 60 * (1 - ease(sl / 0.9)), play.y + 40 * (1 - ease(sl / 0.9)), a);
    ripple(ctx, play.x, play.y, (sl - 0.9) / 0.6);
    phoneShot(ctx, "phone-joined", 1000, 400, 470, a * (1 - lit));
    phoneShot(ctx, "phone-lit", 1000, 400, 470, a * lit, lit * 0.9);
  }
}

// ------------------------------------------------------------------------------------ night crowd

interface Camera {
  x: number;
  h: number;
  z: number;
  pitch: number;
  f: number;
}
/** Projects a world point (metres; x across, y up, z away from the audience) onto the screen. */
function project(cam: Camera, X: number, Y: number, Z: number) {
  const dx = X - cam.x;
  const dy = Y - cam.h;
  const dz = Z - cam.z;
  const c = Math.cos(cam.pitch);
  const s = Math.sin(cam.pitch);
  const yc = dy * c + dz * s;
  const zc = dz * c - dy * s;
  if (zc < 0.5) return null;
  return { x: W / 2 + (cam.f * dx) / zc, y: H / 2 - (cam.f * yc) / zc, s: cam.f / zc };
}

interface Person {
  x: number;
  z: number;
  height: number;
  /** Seconds after the scene starts that this person raises their phone. */
  raiseAt: number;
  channel: number;
  shade: number;
}
/** The party in its usual car shape: phones are dealt the car's lights, so each little group of
 *  people stands where its light is on the front of the car. */
const CROWD_WIDTH = 18;
const CROWD_DEPTH = 8;
const CROWD_NEAR = 16;
const toWorld = (x: number, y: number) => ({ x: (x - 0.5) * CROWD_WIDTH, z: CROWD_NEAR + (1 - y) * CROWD_DEPTH });
const PEOPLE: Person[] = (() => {
  const r = random(11);
  return carLights("front", false).flatMap((light) =>
    Array.from({ length: 6 }, () => ({
      x: toWorld(light.x, light.y).x + (r() - 0.5) * 1.4,
      z: toWorld(light.x, light.y).z + (r() - 0.5) * 1.0,
      height: 1.58 + r() * 0.3,
      raiseAt: 0.7 + (1 - light.y) * 0.5 + r() * 0.9,
      channel: light.channel,
      shade: r(),
    })),
  );
})();
/** The car's outline taped on the ground, stretched like the lights (layouts.ts carLights). */
const TAPE = (() => {
  const centres = LIGHT_SPOTS.filter((s) => s.view === "front").map(({ shape }) =>
    shape.kind === "rect" ? { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 } : { x: shape.cx, y: shape.cy },
  );
  const xs = centres.map((c) => c.x);
  const ys = centres.map((c) => c.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // BODY.shell, as a polygon.
  const outline = [[40, 150], [48, 118], [96, 98], [140, 60], [175, 46], [225, 46], [260, 60], [304, 98], [352, 118], [360, 150], [360, 196], [346, 210], [54, 210], [40, 196]];
  const glass = [[150, 62], [250, 62], [286, 96], [114, 96]];
  const map = (pts: number[][]) => pts.map(([x, y]) => toWorld((x - x0) / (x1 - x0), (y - y0) / (y1 - y0)));
  return [map(outline), map(glass)];
})();

const SKYLINE = (() => {
  const r = random(5);
  const out: { x: number; w: number; h: number; windows: [number, number][] }[] = [];
  for (let x = -260; x < 260; ) {
    const w = 8 + r() * 22;
    const h = 6 + r() * (r() > 0.85 ? 60 : 26);
    const windows: [number, number][] = [];
    for (let i = 0; i < (w * h) / 40; i++) if (r() > 0.6) windows.push([r(), r()]);
    out.push({ x, w, h, windows });
    x += w + r() * 4;
  }
  return out;
})();

/** The crowd at night: people holding up phones that play the show, seen through `cam`. */
function nightCrowd(ctx: Ctx, cam: Camera, t: number, l: number, raised: boolean) {
  const lv = levels(t);
  // Sky and stars.
  const horizon = project(cam, 0, 0, 400);
  const hy = horizon ? horizon.y : -100;
  const sky = ctx.createLinearGradient(0, 0, 0, Math.max(10, hy));
  sky.addColorStop(0, "#03050a");
  sky.addColorStop(1, "#111a2c");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, Math.max(0, hy));
  const r = random(21);
  for (let i = 0; i < 90; i++) {
    const x = r() * W;
    const y = r() * Math.max(0, hy - 40);
    ctx.fillStyle = `rgba(230,236,255,${0.2 + 0.5 * r() * (0.6 + 0.4 * Math.sin(t * 2 + i))})`;
    ctx.fillRect(x, y, 1.6, 1.6);
  }
  // Distant city.
  for (const b of SKYLINE) {
    const p0 = project(cam, b.x, 0, 380);
    const p1 = project(cam, b.x + b.w, b.h, 380);
    if (!p0 || !p1) continue;
    ctx.fillStyle = "#0a0f19";
    ctx.fillRect(p0.x, p1.y, p1.x - p0.x, p0.y - p1.y);
    ctx.fillStyle = "rgba(255,200,120,0.35)";
    for (const [wx, wy] of b.windows) ctx.fillRect(p0.x + wx * (p1.x - p0.x), p1.y + wy * (p0.y - p1.y), 1.5, 1.5);
  }
  // Ground with parking lines.
  const ground = ctx.createLinearGradient(0, Math.max(0, hy), 0, H);
  ground.addColorStop(0, "#0b0f16");
  ground.addColorStop(1, "#06080c");
  ctx.fillStyle = ground;
  ctx.fillRect(0, Math.max(0, hy), W, H);
  ctx.strokeStyle = "rgba(160,170,190,0.08)";
  ctx.lineWidth = 2;
  for (let x = -30; x <= 30; x += 5) {
    const a = project(cam, x, 0, 9);
    const b = project(cam, x, 0, 34);
    if (!a || !b) continue;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // Tape on the ground: the outline of the car, so everyone knows where to stand.
  ctx.save();
  ctx.strokeStyle = "rgba(120,170,255,0.4)";
  ctx.lineWidth = 3;
  ctx.shadowColor = "rgba(90,160,255,0.8)";
  ctx.shadowBlur = 10;
  for (const shape of TAPE) {
    ctx.beginPath();
    let started = false;
    for (const pt of [...shape, shape[0]]) {
      const q = project(cam, pt.x, 0.01, pt.z);
      if (!q) continue;
      if (started) ctx.lineTo(q.x, q.y);
      else ctx.moveTo(q.x, q.y);
      started = true;
    }
    ctx.stroke();
  }
  ctx.restore();

  const people = PEOPLE.map((p) => {
    const raise = raised ? 1 : ease((l - p.raiseAt) / 0.8);
    // Lights come on once the phone is up.
    const on = raise > 0.95;
    const level = on ? levelOf(lv, p.channel) : 0;
    return { ...p, raise, level };
  }).sort((a, b) => b.z - a.z);

  // Light pools on the ground, under everything.
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const p of people) {
    if (p.level < 10) continue;
    const c = project(cam, p.x, 0, p.z - 0.4);
    const side = project(cam, p.x + 1.6, 0, p.z - 0.4);
    const far = project(cam, p.x, 0, p.z + 1.2);
    if (!c || !side || !far) continue;
    const rx = Math.abs(side.x - c.x);
    const ry = Math.max(2, Math.abs(far.y - c.y));
    const [cr, cg, cb] = rgb(colorOf(p.channel));
    const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, rx);
    g.addColorStop(0, `rgba(${cr},${cg},${cb},${0.1 * (p.level / 255)})`);
    g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  for (const p of people) {
    const feet = project(cam, p.x, 0, p.z);
    const head = project(cam, p.x, p.height, p.z);
    if (!feet || !head) continue;
    const s = feet.s;
    const k = p.level / 255;
    const [cr, cg, cb] = rgb(colorOf(p.channel));
    const shade = 7 + p.shade * 7;
    const lit = (v: number, c: number) => Math.round(v + c * k * 0.1);
    ctx.fillStyle = `rgb(${lit(shade, cr)},${lit(shade + 3, cg)},${lit(shade + 8, cb)})`;
    // Body: from the feet to the shoulders, foreshortened by the projection.
    const shoulder = project(cam, p.x, p.height - 0.28, p.z);
    if (!shoulder) continue;
    const bw = 0.24 * s;
    ctx.beginPath();
    ctx.moveTo(feet.x - bw * 0.7, feet.y);
    ctx.lineTo(shoulder.x - bw, shoulder.y);
    ctx.quadraticCurveTo(shoulder.x, shoulder.y - bw * 0.35, shoulder.x + bw, shoulder.y);
    ctx.lineTo(feet.x + bw * 0.7, feet.y);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(head.x, head.y + 0.1 * s, Math.max(1, 0.12 * s), 0, Math.PI * 2);
    ctx.fill();
    // Arm and phone.
    const phoneY = 1.15 + (p.height + 0.42 - 1.15) * p.raise;
    const hand = project(cam, p.x + 0.12 + 0.1 * p.raise, phoneY, p.z - 0.15);
    const arm = project(cam, p.x + 0.2, p.height - 0.3, p.z);
    if (!hand || !arm) continue;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = Math.max(1, 0.08 * s);
    ctx.beginPath();
    ctx.moveTo(arm.x, arm.y);
    ctx.lineTo(hand.x, hand.y);
    ctx.stroke();
    const pw = Math.max(1.5, 0.08 * s);
    const phh = Math.max(2.5, 0.15 * s);
    const screen = 0.12 + 0.88 * k;
    ctx.fillStyle = k > 0.02 ? `rgb(${Math.round(cr * screen)},${Math.round(cg * screen)},${Math.round(cb * screen)})` : `rgba(90,120,170,${0.25 * p.raise})`;
    ctx.fillRect(hand.x - pw / 2, hand.y - phh, pw, phh);
    if (k > 0.03) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      // Glow round the phone.
      const glow = ctx.createRadialGradient(hand.x, hand.y - phh / 2, 0, hand.x, hand.y - phh / 2, 0.9 * s);
      glow.addColorStop(0, `rgba(${cr},${cg},${cb},${0.4 * k})`);
      glow.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(hand.x - 0.9 * s, hand.y - phh / 2 - 0.9 * s, 1.8 * s, 1.8 * s);
      // Flashlight beam into the night haze.
      if (k >= 0.5) {
        const top = project(cam, p.x + 0.2, phoneY + 5, p.z - 0.4);
        if (top) {
          const beam = ctx.createLinearGradient(hand.x, hand.y, top.x, top.y);
          beam.addColorStop(0, `rgba(255,248,230,${0.07 * k})`);
          beam.addColorStop(1, "rgba(255,248,230,0)");
          ctx.fillStyle = beam;
          const spread = 0.6 * top.s;
          ctx.beginPath();
          ctx.moveTo(hand.x - pw * 0.4, hand.y - phh);
          ctx.lineTo(hand.x + pw * 0.4, hand.y - phh);
          ctx.lineTo(top.x + spread, top.y);
          ctx.lineTo(top.x - spread, top.y);
          ctx.closePath();
          ctx.fill();
        }
        // A small star of light on the lens.
        ctx.fillStyle = `rgba(255,255,255,${0.8 * k})`;
        ctx.fillRect(hand.x - 0.35 * s, hand.y - phh - 0.5, 0.7 * s, 1);
        ctx.fillRect(hand.x - 0.5, hand.y - phh - 0.35 * s, 1, 0.7 * s);
      }
      ctx.restore();
    }
  }

  // Haze over the crowd, tinted by what is lit.
  let lit = 0;
  let red = 0;
  let amber = 0;
  for (const p of people) {
    const k = p.level / 255;
    lit += k;
    const c = colorOf(p.channel);
    if (c === COLORS.red) red += k;
    if (c === COLORS.amber) amber += k;
  }
  const centre = project(cam, 0, 2.5, CROWD_NEAR + CROWD_DEPTH / 2);
  if (centre && lit > 0) {
    const share = clamp(lit / 25);
    const tint = amber > red && amber > lit / 3 ? [255, 180, 80] : red > lit / 3 ? [255, 80, 80] : [255, 240, 220];
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const g = ctx.createRadialGradient(centre.x, centre.y, 0, centre.x, centre.y, 26 * centre.s);
    g.addColorStop(0, `rgba(${tint.join(",")},${0.13 * share})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  // Vignette.
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.65)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

// ------------------------------------------------------------------------------------ scenes

const scenes: Scene[] = [
  {
    start: 0,
    end: 4,
    draw(ctx, l) {
      const r = random(3);
      for (let i = 0; i < 70; i++) {
        const x = r() * W;
        const y = r() * H;
        const tw = Math.max(0, Math.sin(l * 2 + i)) ** 4;
        ctx.fillStyle = rgba(i % 5 === 0 ? COLORS.amber : COLORS.white, 0.12 + 0.5 * tw * ramp(l, 0.2, 1));
        ctx.beginPath();
        ctx.arc(x, y, 2 + 2 * tw, 0, Math.PI * 2);
        ctx.fill();
      }
      const a = ramp(l, 0.2, 0.9);
      ctx.save();
      ctx.globalAlpha = a;
      logo(ctx, W / 2, 250, 46, 0.8 + 0.6 * Math.sin(l * 3));
      ctx.restore();
      text(ctx, "Light Show Anywhere", W / 2, 360 + 20 * (1 - a), { size: 72, weight: 700, align: "center", alpha: a });
      const b = ramp(l, 1.2);
      text(ctx, "Human Tesla: every phone is one light", W / 2, 440, { size: 32, color: ACCENT, align: "center", alpha: b });
      text(ctx, "Play real Tesla light shows on a crowd of phones", W / 2, 495, { size: 24, color: MUTED, align: "center", alpha: ramp(l, 1.9) });
    },
  },
  {
    start: 4,
    end: 8,
    step: "The idea",
    heading: "A light show needs a Tesla. What if the crowd is the car?",
    draw(ctx, l, t) {
      const a = ramp(l, 0.1);
      panel(ctx, 70, 160, 500, 420, a);
      text(ctx, "Normally", 320, 205, { size: 22, color: MUTED, align: "center", alpha: a });
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(120, 250);
      ctx.scale(1.0, 1.0);
      ctx.fillStyle = "#121925";
      ctx.strokeStyle = "#2a3445";
      ctx.lineWidth = 3;
      const shell = new Path2D(BODY.shell);
      ctx.fill(shell);
      ctx.stroke(shell);
      ctx.fillStyle = "#0a0f17";
      ctx.fill(new Path2D(BODY.glass));
      for (const [cx, ch] of [[95, 1], [305, 2]] as const) {
        const k = idle(t, ch) / 255;
        ctx.shadowColor = COLORS.white;
        ctx.shadowBlur = 30 * k;
        ctx.fillStyle = `rgba(255,244,220,${0.25 + 0.75 * k})`;
        ctx.beginPath();
        ctx.ellipse(cx, 140, 34, 10, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      text(ctx, "one Tesla, one show", 320, 530, { size: 24, weight: 600, align: "center", alpha: a });

      const b = ramp(l, 1.2);
      arrow(ctx, 600, 370, 680, 370, b, ACCENT);
      panel(ctx, 710, 160, 500, 420, b, rgba(ACCENT, 0.5));
      text(ctx, "Light Show Anywhere", 960, 205, { size: 22, color: ACCENT, align: "center", alpha: b });
      crowd(ctx, CAR_CROWD, (ch) => idle(t, ch), 750, 250, 420, 230, 20, ramp(l, 1.4, 2));
      text(ctx, "a crowd of phones, no car needed", 960, 530, { size: 24, weight: 600, align: "center", alpha: b });
    },
  },
  {
    start: SONG_AT,
    end: 36,
    step: "1 · The engine",
    heading: "The show is emulated like a real Tesla",
    draw(ctx, l, t) {
      const boxes = [".fseq show", "Rust parser", "Tesla emulator", "WebAssembly", "Live preview"];
      boxes.forEach((s, i) => {
        const a = ramp(l, 0.2 + i * 0.35, 0.5);
        const x = 70 + i * 232;
        panel(ctx, x, 150, 190, 64, a, i === 2 ? rgba(ACCENT, 0.7) : LINE);
        text(ctx, s, x + 95, 182, { size: 21, weight: 600, align: "center", alpha: a, color: i === 2 ? ACCENT : TEXT });
        if (i > 0) arrow(ctx, x - 40, 182, x - 6, 182, a);
      });
      const pulse = (l * 0.6) % 1;
      ctx.fillStyle = rgba(ACCENT, ramp(l, 2));
      ctx.beginPath();
      ctx.arc(70 + pulse * (232 * 4 + 190), 222, 4, 0, Math.PI * 2);
      ctx.fill();

      car(ctx, t, 210, 226, 860, ramp(l, 1.6, 0.8));
      const facts = ["byte 178 = on over 500 ms", "byte 255 = on instantly", "doors & mirrors move", "4 models + Cybertruck"];
      let x = 110;
      facts.forEach((f, i) => {
        x += chip(ctx, f, x, 612, ramp(l, 3 + i * 0.8), i % 2 ? COLORS.amber : ACCENT, 17) + 14;
      });
    },
  },
  {
    start: 43,
    end: 49.5,
    step: "3 · The party",
    heading: "Scan the QR code. Your phone becomes one light.",
    draw(ctx, l, t) {
      const lv = levels(t);
      const a = ramp(l, 0.1);
      panel(ctx, 60, 150, 330, 470, a);
      text(ctx, "Host", 225, 185, { size: 20, color: MUTED, align: "center", alpha: a });
      ctx.save();
      ctx.globalAlpha = a;
      qr(ctx, 125, 215, 200);
      ctx.restore();
      text(ctx, "Room", 135, 470, { size: 22, color: MUTED, alpha: a });
      text(ctx, "K T X R", 205, 470, { size: 30, weight: 700, color: ACCENT, alpha: a, font: "ui-monospace, monospace" });
      const joined = Math.min(CAR_CROWD.length, Math.floor(ramp(l, 1, 4.5) * CAR_CROWD.length));
      text(ctx, `Phones (${joined})`, 135, 525, { size: 24, weight: 600, alpha: a });
      text(ctx, "Left Outer Main Beam · Right Outer…", 135, 565, { size: 17, color: MUTED, alpha: ramp(l, 2) });

      panel(ctx, 420, 150, 800, 470, a);
      text(ctx, "The crowd, from the front", 820, 185, { size: 20, color: MUTED, align: "center", alpha: a });
      crowd(ctx, CAR_CROWD, (ch) => levelOf(lv, ch), 450, 225, 740, 330, 30, ramp(l, 1, 4.5));
      if (l > 6) {
        let x = 450;
        ["each phone: one light", "white · amber · red", "+ flashlight on Android & iPhone"].forEach((s, i) => {
          x += chip(ctx, s, x, 592, ramp(l, 6 + i * 0.7), i === 1 ? COLORS.amber : ACCENT, 16) + 12;
        });
      }
    },
  },
  {
    start: 57,
    end: 61,
    step: "5 · In sync",
    heading: "Different phones, one clock, every flash together",
    draw(ctx, l, t) {
      const lv = levels(t);
      // Every device plays the same light here, so you can see them flash together.
      let level = 0;
      for (let c = 1; c <= 30; c++) level = Math.max(level, levelOf(lv, c));
      const a = ramp(l, 0.1);
      panel(ctx, 545, 140, 190, 58, a, rgba(ACCENT, 0.7));
      text(ctx, "Party server", 640, 169, { size: 20, weight: 600, align: "center", alpha: a });

      const devices: { kind: Device; label: string; x: number }[] = [
        { kind: "iphone", label: "iPhone · Safari", x: 150 },
        { kind: "android", label: "Android · Chrome", x: 340 },
        { kind: "tablet", label: "iPad", x: 545 },
        { kind: "fold", label: "Foldable", x: 760 },
        { kind: "classic", label: "Older iPhone", x: 945 },
        { kind: "pixel", label: "Pixel", x: 1125 },
      ];
      devices.forEach((d, i) => {
        const b = ramp(l, 0.2 + i * 0.15);
        // Clock sync: pings go up, replies come back.
        const p = (l * 1.1 + i * 0.17) % 1;
        const up = p < 0.5;
        const q = up ? p * 2 : (1 - p) * 2;
        ctx.strokeStyle = rgba("#2a3445", b);
        ctx.setLineDash([5, 8]);
        ctx.beginPath();
        ctx.moveTo(d.x, 300);
        ctx.lineTo(640, 200);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = rgba(up ? ACCENT : COLORS.amber, b * (l < 3.5 ? 1 : 0.35));
        ctx.beginPath();
        ctx.arc(d.x + (640 - d.x) * q, 300 + (200 - 300) * q, 5, 0, Math.PI * 2);
        ctx.fill();
        device(ctx, d.kind, d.x, 430, level, b);
        text(ctx, d.label, d.x, 548, { size: 17, color: MUTED, align: "center", alpha: b });
      });
      text(ctx, "offset = s1 − (c0 + c1) / 2   ·   start together at t0", 640, 590, {
        size: 22,
        weight: 600,
        align: "center",
        alpha: ramp(l, 1),
        font: "ui-monospace, monospace",
      });
      chip(ctx, "measured: phones within 17 ms of each other", 420, 628, ramp(l, 2.5), COLORS.amber, 18);
    },
  },
  {
    start: 36,
    end: 43,
    step: "2 · Safe to watch",
    heading: "No fast strobing on anyone's phone",
    draw(ctx, l) {
      const step = 20;
      const raw: number[] = [];
      for (let f = 0; f < 200; f++) raw.push(f < 110 ? (Math.floor(f / 2) % 2 ? 255 : 0) : Math.floor(f / 25) % 2 ? 255 : 0);
      const safe = govern(raw, step);
      const show = Math.min(raw.length, Math.floor(ramp(l, 0.3, 4.5) * raw.length));
      const lane = (y: number, data: number[], color: string, label: string, alpha: number) => {
        panel(ctx, 80, y, 1120, 170, alpha);
        text(ctx, label, 110, y + 30, { size: 21, weight: 600, color, alpha });
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        for (let i = 0; i < show; i++) {
          const x = 110 + (i / raw.length) * 1060;
          const yy = y + 150 - (data[i] / 255) * 95;
          if (i === 0) ctx.moveTo(x, yy);
          else ctx.lineTo(x, yy);
        }
        ctx.stroke();
        ctx.restore();
      };
      lane(150, raw, COLORS.red, "What the show asks for: a 12 Hz strobe", ramp(l, 0.1));
      lane(350, safe, ACCENT, "What phones play: slower, full pulses", ramp(l, 0.5));
      let x = 110;
      ["≤ 3 flashes / second", "≥ 150 ms fades", "applied to every phone and LED strip"].forEach((s, i) => {
        x += chip(ctx, s, x, 575, ramp(l, 2.5 + i * 0.6), i === 2 ? COLORS.amber : ACCENT, 18) + 14;
      });
    },
  },
  {
    start: 69,
    end: 84,
    step: "7 · Made for real parties",
    heading: "Small things that make it work in a real room",
    draw(ctx, l, t) {
      const cards: [string, string, (x: number, y: number, a: number) => void][] = [
        [
          "Speaker delay, measured",
          "Phones hear 5 tones; the median delay sets the song early",
          (x, y, a) => {
            ctx.save();
            ctx.globalAlpha = a;
            ctx.strokeStyle = ACCENT;
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let i = 0; i <= 240; i++) {
              const u = i / 240;
              const env = Math.sin(Math.PI * u) ** 2;
              const yy = y + 50 - 34 * env * Math.sin(2 * Math.PI * (4 * u + 14 * u * u) - l * 6);
              if (i === 0) ctx.moveTo(x + 30 + u * 420, yy);
              else ctx.lineTo(x + 30 + u * 420, yy);
            }
            ctx.stroke();
            ctx.restore();
          },
        ],
        [
          "LED strips (WLED)",
          "Strips join over DDP and play the same safe tracks",
          (x, y, a) => {
            for (let i = 0; i < 36; i++) {
              const k = Math.max(0, Math.sin(l * 4 - i * 0.35)) ** 2;
              const c = i % 3 === 0 ? COLORS.amber : i % 3 === 1 ? COLORS.white : COLORS.red;
              ctx.fillStyle = rgba(c, a * (0.15 + 0.85 * k));
              ctx.shadowColor = c;
              ctx.shadowBlur = 14 * k;
              ctx.beginPath();
              ctx.arc(x + 40 + i * 11.5, y + 50, 4.5, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.shadowBlur = 0;
          },
        ],
        [
          "Export video",
          "MP4 with the song, frame-exact, faster than real time",
          (x, y, a) => {
            ctx.save();
            ctx.globalAlpha = a;
            for (let i = 0; i < 6; i++) {
              const fx = x + 30 + ((i * 76 + l * 60) % 456);
              roundRect(ctx, fx, y + 22, 64, 56, 6);
              ctx.fillStyle = "#121925";
              ctx.fill();
              ctx.fillStyle = rgba(COLORS.white, 0.3 + 0.7 * (idle(t, i) / 255));
              ctx.fillRect(fx + 12, y + 46, 14, 6);
              ctx.fillRect(fx + 38, y + 46, 14, 6);
            }
            ctx.restore();
          },
        ],
        [
          "Built for bad Wi-Fi",
          "Phones keep playing offline and take their light back",
          (x, y, a) => {
            const off = Math.floor(l * 1.2) % 2 === 1;
            ctx.save();
            ctx.globalAlpha = a;
            ctx.strokeStyle = off ? COLORS.red : ACCENT;
            ctx.lineWidth = 4;
            for (let i = 1; i <= 3; i++) {
              ctx.beginPath();
              ctx.arc(x + 90, y + 80, i * 18, -Math.PI * 0.75, -Math.PI * 0.25);
              ctx.stroke();
            }
            ctx.restore();
            phone(ctx, x + 250, y + 50, 30, COLORS.white, idle(t, 3), a);
            text(ctx, off ? "offline · still playing" : "back · same light", x + 300, y + 50, { size: 18, color: off ? COLORS.amber : ACCENT, alpha: a });
          },
        ],
      ];
      cards.forEach(([title, sub, draw], i) => {
        const x = 70 + (i % 2) * 580;
        const y = 150 + Math.floor(i / 2) * 240;
        const a = ramp(l, 0.2 + i * 0.6);
        panel(ctx, x, y + (1 - a) * 20, 560, 220, a);
        text(ctx, title, x + 30, y + 40, { size: 26, weight: 700, alpha: a });
        text(ctx, sub, x + 30, y + 80, { size: 18, color: MUTED, alpha: a });
        draw(x, y + 100, a);
      });
    },
  },
  {
    start: 84,
    end: 92,
    draw(ctx, l, t) {
      const a = ramp(l, 0.1);
      text(ctx, "How it's built", W / 2, 120, { size: 22, color: MUTED, align: "center", alpha: a });
      const stack: [string, string][] = [
        ["Rust", "FSEQ parser · Tesla emulator · party server"],
        ["WebAssembly", "the same engine in the browser"],
        ["React + TypeScript", "preview, host panel, phone page"],
        ["WebSocket + clock sync", "one start time for every phone"],
      ];
      stack.forEach(([name, what], i) => {
        const b = ramp(l, 0.3 + i * 0.35);
        const y = 180 + i * 62;
        text(ctx, name, 600, y, { size: 28, weight: 700, align: "right", alpha: b, color: i % 2 ? COLORS.amber : ACCENT });
        text(ctx, what, 630, y, { size: 24, alpha: b });
      });
      const c = ramp(l, 3.2, 0.9);
      ctx.save();
      ctx.globalAlpha = c;
      logo(ctx, W / 2, 490, 30, 1 + 0.6 * Math.sin(t * 3));
      ctx.restore();
      text(ctx, "Light Show Anywhere", W / 2, 560, { size: 56, weight: 700, align: "center", alpha: c });
      text(ctx, "Every phone is one light.", W / 2, 615, { size: 26, color: ACCENT, align: "center", alpha: ramp(l, 3.8) });
    },
  },
  {
    start: 8,
    end: SONG_AT,
    draw(ctx, l) {
      walkthrough(ctx, l);
    },
  },
  {
    start: 49.5,
    end: 57,
    draw(ctx, l, t) {
      const k = ease(l / 7.5);
      nightCrowd(ctx, { x: -1.5 + 3 * k, h: 3.4 + 1.4 * k, z: 1.5 + 3.5 * k, pitch: 0.15 + 0.08 * k, f: 820 }, t, l, false);
      text(ctx, "4 · TOGETHER", 70, 58, { size: 17, weight: 700, color: ACCENT, alpha: ramp(l, 0.2) });
      text(ctx, "Phones up. Flashlights on.", 70, 98, { size: 36, weight: 700, alpha: ramp(l, 0.2) });
    },
  },
  {
    start: 61,
    end: 69,
    draw(ctx, l, t) {
      const k = ease(l / 8);
      nightCrowd(ctx, { x: 0, h: 4.5 + 19.5 * k, z: 4 + 8.5 * k, pitch: 0.24 + 1.01 * k, f: 880 }, t, l, true);
      text(ctx, "6 · FROM ABOVE", 70, 58, { size: 17, weight: 700, color: ACCENT, alpha: ramp(l, 0.2) });
      text(ctx, "A car, drawn by people", 70, 98, { size: 36, weight: 700, alpha: ramp(l, 0.2) });
    },
  },
];

scenes.sort((a, b) => a.start - b.start);
export const DURATION = scenes[scenes.length - 1].end;

/** Draws the whole video at time `t` seconds. */
export function drawDemo(ctx: Ctx, t: number) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  const scene = scenes.find((s) => t >= s.start && t < s.end) ?? scenes[scenes.length - 1];
  const local = t - scene.start;
  const fadeIn = clamp(local / 0.45);
  const fadeOut = scene === scenes[scenes.length - 1] ? clamp((DURATION - t) / 1.2) : clamp((scene.end - t) / 0.45);
  ctx.save();
  ctx.globalAlpha = Math.min(fadeIn, fadeOut);
  if (scene.step) {
    text(ctx, scene.step.toUpperCase(), 70, 58, { size: 17, weight: 700, color: ACCENT });
    text(ctx, scene.heading ?? "", 70, 98, { size: 36, weight: 700 });
  }
  scene.draw(ctx, local, t);
  ctx.restore();
  // Subtitles: what the narrator is saying.
  const line = NARRATION.find(([at, room]) => t >= at && t < at + room);
  if (line) {
    const [at, room, words] = line;
    const a = clamp((t - at) / 0.25) * clamp((at + room - t) / 0.25);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = "500 22px system-ui, sans-serif";
    const w = Math.min(W - 80, ctx.measureText(words).width + 40);
    roundRect(ctx, W / 2 - w / 2, H - 62, w, 40, 10);
    ctx.fillStyle = "rgba(5,7,10,0.78)";
    ctx.fill();
    ctx.restore();
    text(ctx, words, W / 2, H - 42, { size: 22, weight: 500, align: "center", alpha: a });
  }
  // Progress line along the bottom edge.
  ctx.fillStyle = LINE;
  ctx.fillRect(0, H - 3, W, 3);
  ctx.fillStyle = ACCENT;
  ctx.fillRect(0, H - 3, (W * t) / DURATION, 3);
}

// ------------------------------------------------------------------------------------ audio

/** A soft pad under the whole video, with the show's song mixed in while the show plays. */
async function soundtrack(song: ArrayBuffer | null): Promise<AudioBuffer> {
  const rate = 48000;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(DURATION * rate), sampleRate: rate });
  const master = ctx.createGain();
  master.connect(ctx.destination);

  const pad = ctx.createGain();
  pad.connect(master);
  pad.gain.setValueAtTime(0, 0);
  pad.gain.linearRampToValueAtTime(0.16, 2);
  pad.gain.setValueAtTime(0.16, SONG_AT - 1.5);
  pad.gain.linearRampToValueAtTime(0.03, SONG_AT);
  pad.gain.setValueAtTime(0.03, SONG_END - 1);
  pad.gain.linearRampToValueAtTime(0.16, SONG_END + 0.5);
  pad.gain.setValueAtTime(0.16, DURATION - 2.5);
  pad.gain.linearRampToValueAtTime(0, DURATION);
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1400;
  filter.connect(pad);
  // A minor, F, C, G: four seconds each.
  const chords = [
    [220, 261.63, 329.63],
    [174.61, 220, 261.63],
    [130.81, 196, 261.63],
    [196, 246.94, 293.66],
  ];
  for (let start = 0, i = 0; start < DURATION; start += 4, i++) {
    for (const f of chords[i % chords.length]) {
      for (const [type, detune, level] of [["sine", 0, 0.22], ["triangle", 7, 0.08]] as const) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = f;
        osc.detune.value = detune;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(level, start + 1.2);
        g.gain.setValueAtTime(level, start + 3.4);
        g.gain.linearRampToValueAtTime(0, start + 4.4);
        osc.connect(g).connect(filter);
        osc.start(start);
        osc.stop(Math.min(DURATION, start + 4.5));
      }
    }
  }

  if (song) {
    const buffer = await ctx.decodeAudioData(song);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, SONG_AT);
    g.gain.linearRampToValueAtTime(0.9, SONG_AT + 0.4);
    g.gain.setValueAtTime(0.9, SONG_END - 1.2);
    g.gain.linearRampToValueAtTime(0, SONG_END);
    source.connect(g).connect(master);
    source.start(SONG_AT, 0, SONG_END - SONG_AT);
  }
  return ctx.startRendering();
}

// ------------------------------------------------------------------------------------ export

interface Rendered {
  bytes: Uint8Array;
  mimeType: string;
  /** With the dot: ".mp4" or ".webm". */
  extension: string;
}

async function renderVideo(song: ArrayBuffer | null, onProgress: (f: number) => void): Promise<Rendered> {
  const mb = await import("mediabunny");
  const codec = await mb.getFirstEncodableVideoCodec(["avc", "vp9"], { width: W, height: H });
  if (!codec) throw new Error("this browser cannot encode video");
  const mp4 = codec === "avc";
  // H.264 goes in MP4; a browser without it gets VP9 in WebM.
  const format = mp4 ? new mb.Mp4OutputFormat({ fastStart: "in-memory" }) : new mb.WebMOutputFormat();
  const output = new mb.Output({ format, target: new mb.BufferTarget() });
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d")!;
  const video = new mb.CanvasSource(canvas, { codec, quality: mb.QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: FPS });
  const audio = await soundtrack(song);
  const audioCodec = await mb.getFirstEncodableAudioCodec(mp4 ? ["aac", "opus"] : ["opus"], {
    numberOfChannels: 2,
    sampleRate: audio.sampleRate,
  });
  const audioSource = audioCodec ? new mb.AudioBufferSource({ codec: audioCodec, quality: mb.QUALITY_HIGH }) : null;
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();
  if (audioSource) await audioSource.add(audio);
  const frames = Math.round(DURATION * FPS);
  for (let i = 0; i < frames; i++) {
    drawDemo(ctx, i / FPS);
    await video.add(i / FPS, 1 / FPS);
    if (i % FPS === 0) onProgress(i / frames);
  }
  await output.finalize();
  onProgress(1);
  return {
    bytes: new Uint8Array((output.target as InstanceType<typeof mb.BufferTarget>).buffer!),
    mimeType: format.mimeType,
    extension: format.fileExtension,
  };
}

// ------------------------------------------------------------------------------------ page

const params = new URLSearchParams(location.search);
const status = document.getElementById("status")!;
const canvas = document.getElementById("demo") as HTMLCanvasElement;
const pageCtx = canvas.getContext("2d")!;

async function fetchBytes(url: string | null): Promise<ArrayBuffer | null> {
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.arrayBuffer();
}

const ready = (async () => {
  await loadEngine();
  const [fseq, song] = await Promise.all([fetchBytes(params.get("show")), fetchBytes(params.get("song"))]);
  if (fseq) show = new Show(new Uint8Array(fseq), "model-3y");
  // Screenshots of the real app for the walkthrough (scripts/capture-app.mjs).
  const folder = params.get("shots");
  if (folder) {
    await Promise.all(
      SHOT_NAMES.map(async (name) => {
        const img = new Image();
        img.src = `${folder}/${name}.png`;
        await img.decode();
        shots[name] = img;
      }),
    );
  }
  status.textContent = `${DURATION} s demo${show ? "" : " (no show loaded: add ?show=)"}`;
  return song;
})();

const still = params.get("t");
void ready.then(() => {
  if (still !== null) {
    drawDemo(pageCtx, Number(still));
    return;
  }
  const started = performance.now();
  const loop = () => {
    drawDemo(pageCtx, ((performance.now() - started) / 1000) % DURATION);
    requestAnimationFrame(loop);
  };
  loop();
});

async function render(): Promise<Rendered> {
  const song = await ready;
  const video = await renderVideo(song, (f) => (status.textContent = `Rendering… ${Math.round(f * 100)}%`));
  status.textContent = `Done: ${(video.bytes.length / 1e6).toFixed(1)} MB`;
  return video;
}

document.getElementById("render")!.addEventListener("click", () => {
  void render().then(({ bytes, mimeType, extension }) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
    a.download = `light-show-anywhere-demo${extension}`;
    a.click();
  });
});

// For scripts/make-demo.mjs: the narration, then render and read the file in base64 slices.
const hooks = window as unknown as {
  __demoNarration: typeof NARRATION;
  __renderDemo: () => Promise<number>;
  __demoSlice: (from: number, to: number) => string;
};
hooks.__demoNarration = NARRATION;
let rendered: Uint8Array | null = null;
hooks.__renderDemo = async () => {
  rendered = (await render()).bytes;
  return rendered.length;
};
hooks.__demoSlice = (from, to) => {
  let s = "";
  const part = rendered!.subarray(from, to);
  for (let i = 0; i < part.length; i += 0x8000) s += String.fromCharCode(...part.subarray(i, i + 0x8000));
  return btoa(s);
};
