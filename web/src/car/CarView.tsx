import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { Vehicle } from "../engine";
import {
  BODY,
  INTERIOR,
  LIGHT_BARS,
  LIGHT_SPOTS,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  type LightSpot,
  type Shape,
  type View,
} from "./layout";
import {
  CLOSURE,
  GROUND_Y,
  HALOS,
  bodyGlow,
  chargePortLight,
  falconAngle,
  idleLevels,
  lidPose,
  mirrorWidth,
  pools,
  windowGlass,
} from "./scene";

export interface CarViewHandle {
  /** Applies one frame of channel levels (0–255). Called every animation frame. */
  update(levels: Uint8Array | undefined): void;
}

interface Props {
  showBars: boolean;
  vehicle: Vehicle;
  /** No show loaded: play the demo (breathing lights) instead. */
  idle: boolean;
  nameOf: (channel: number) => string;
}

/** Side repeaters sit on the mirrors (front view), so they fold with them. */
const ON_MIRROR = new Set([21, 22]);

// Geometry of the moving parts, for the car's left side as seen from the front (picture right);
// the right side and the rear view mirror it.
const MIRROR = { pivotX: 298, pivotY: 97, stalk: "M296 95 L334 92 L334 97 L296 100 Z", housing: { x: 330, y: 84, w: 36, h: 15 } };
const FALCON = { pivotX: 214, pivotY: 50, door: "M0 -5 L110 -9 Q118 -9 118 -2 L118 6 Q118 11 111 11 L0 6 Z", glass: "M14 -3 L84 -6 L84 3 L14 3 Z" };
const SIDE_WINDOW = { points: "252,62 259,61 301,97 288,97", top: 61, bottom: 97 };
/** Rear view, car's left (picture left): the charge port on the flank. */
const PORT = { x: 43, y: 126, w: 10, h: 14 };
const LID_FRUNK = "M118 97 L282 97 L298 108 L102 108 Z";

/** Mirror image across the middle of the picture. */
const FLIP = `translate(${VIEW_WIDTH} 0) scale(-1 1)`;

const id = (view: View, name: string, color = "") => `${name}-${view}${color ? `-${color.slice(1)}` : ""}`;

function ShapeEl({ shape, ...rest }: { shape: Shape } & React.SVGProps<SVGElement>) {
  if (shape.kind === "rect") {
    return (
      <rect
        x={shape.x}
        y={shape.y}
        width={shape.w}
        height={shape.h}
        rx={shape.r ?? 0}
        {...(rest as React.SVGProps<SVGRectElement>)}
      />
    );
  }
  return <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} {...(rest as React.SVGProps<SVGEllipseElement>)} />;
}

/** A lamp: dark lens, its light (opacity = level) and a bloom around it. */
function Lamp({ spot, view, nameOf }: { spot: LightSpot; view: View; nameOf: (channel: number) => string }) {
  const halo = HALOS.find((h) => h.view === view && h.channel === spot.channel && h.cx === centreX(spot.shape));
  return (
    <g>
      <title>{`${spot.channel} · ${nameOf(spot.channel)}`}</title>
      <ShapeEl shape={spot.shape} className="lens" />
      {halo && (
        <circle className="halo" cx={halo.cx} cy={halo.cy} r={halo.r} fill={`url(#${id(view, "halo", spot.color)})`} data-halo={spot.channel} />
      )}
      <ShapeEl shape={spot.shape} className="lit" fill={spot.color} filter={`url(#${id(view, "glow")})`} data-ch={spot.channel} />
    </g>
  );
}

const centreX = (shape: Shape) => (shape.kind === "rect" ? shape.x + shape.w / 2 : shape.cx);

/** One side's mirror; `side` is the car's side, `flip` mirrors it to the other side of the picture. */
function Mirror({ channel, flip, children }: { channel: number; flip: boolean; children?: React.ReactNode }) {
  const { pivotX, pivotY, stalk, housing } = MIRROR;
  return (
    <g transform={flip ? FLIP : undefined}>
      <g className="mirror" data-mirror={channel} data-pivot={`${pivotX} ${pivotY}`}>
        <path className="body-part" d={stalk} />
        <rect className="body-part" x={housing.x} y={housing.y} width={housing.w} height={housing.h} rx={5} />
        {children && <g transform={flip ? FLIP : undefined}>{children}</g>}
      </g>
    </g>
  );
}

function FalconDoor({ channel, flip }: { channel: number; flip: boolean }) {
  const { pivotX, pivotY, door, glass } = FALCON;
  return (
    <g transform={flip ? FLIP : undefined}>
      <g transform={`translate(${pivotX} ${pivotY})`}>
        <g className="falcon" data-falcon={channel} transform={`rotate(${falconAngle(0)})`}>
          <path className="body-part" d={door} />
          <path className="glass" d={glass} />
        </g>
      </g>
    </g>
  );
}

function SideWindow({ channel, flip, view }: { channel: number; flip: boolean; view: View }) {
  const clip = id(view, `window-${channel}`);
  return (
    <g transform={flip ? FLIP : undefined}>
      <clipPath id={clip}>
        <rect data-window={channel} x={240} width={80} y={SIDE_WINDOW.top} height={SIDE_WINDOW.bottom - SIDE_WINDOW.top} />
      </clipPath>
      <polygon className="side-window-frame" points={SIDE_WINDOW.points} />
      <polygon className="side-window" points={SIDE_WINDOW.points} clipPath={`url(#${clip})`} />
    </g>
  );
}

/** A lid on a hinge (rear liftgate with the rear window, or the Cybertruck frunk): it lifts and
 *  shows the lit space under it. */
function Lid({ view, d, hingeY, glass }: { view: View; d: string; hingeY: number; glass: boolean }) {
  return (
    <g>
      <path className="lid-opening" d={d} fill={`url(#${id(view, "cargo")})`} data-lid-light={CLOSURE.liftgate} />
      <g className="lid" data-lid={CLOSURE.liftgate} data-pivot={`0 ${hingeY}`}>
        <path className={glass ? "glass rear-window" : "body-part"} data-glass={glass ? "" : undefined} d={d} />
      </g>
    </g>
  );
}

function ChargePort({ view }: { view: View }) {
  const { x, y, w, h } = PORT;
  return (
    <g>
      <rect className="port-socket" x={x} y={y} width={w} height={h} rx={2} />
      <circle className="port-light" cx={x + w / 2} cy={y + h / 2} r={9} fill={`url(#${id(view, "port")})`} data-port-light={CLOSURE.chargePort} />
      <rect className="port-door body-part" x={x} y={y} width={w} height={h} rx={2} data-port={CLOSURE.chargePort} data-pivot={`${x} 0`} />
    </g>
  );
}

function Defs({ view }: { view: View }) {
  const colors = [...new Set([...LIGHT_SPOTS.map((s) => s.color), ...LIGHT_BARS.map((b) => b.color)])];
  return (
    <defs>
      <filter id={id(view, "glow")} x="-50%" y="-200%" width="200%" height="500%">
        <feGaussianBlur stdDeviation="3" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      {colors.map((color) => (
        <g key={color}>
          <radialGradient id={id(view, "halo", color)}>
            <stop offset="0" stopColor={color} stopOpacity={0.75} />
            <stop offset="0.35" stopColor={color} stopOpacity={0.28} />
            <stop offset="1" stopColor={color} stopOpacity={0} />
          </radialGradient>
          <radialGradient id={id(view, "pool", color)}>
            <stop offset="0" stopColor={color} stopOpacity={0.9} />
            <stop offset="1" stopColor={color} stopOpacity={0} />
          </radialGradient>
        </g>
      ))}
      <radialGradient id={id(view, "sheen")} cx="50%" cy="46%" r="42%">
        <stop offset="0" stopColor="#ffffff" data-sheen-stop="" />
        <stop offset="1" stopColor="#ffffff" stopOpacity={0} data-sheen-stop="" />
      </radialGradient>
      <radialGradient id={id(view, "floor")} cx="50%" cy="50%" r="50%">
        <stop offset="0" stopColor="#000" stopOpacity={0.85} />
        <stop offset="1" stopColor="#000" stopOpacity={0} />
      </radialGradient>
      <radialGradient id={id(view, "port")}>
        <stop offset="0" stopColor="currentColor" />
        <stop offset="0.3" stopColor="currentColor" stopOpacity={0.6} />
        <stop offset="1" stopColor="currentColor" stopOpacity={0} />
      </radialGradient>
      <linearGradient id={id(view, "cargo")} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffd59a" />
        <stop offset="1" stopColor="#a8641c" />
      </linearGradient>
      <clipPath id={id(view, "shell")}>
        <path d={BODY.shell} />
      </clipPath>
    </defs>
  );
}

function CarSvg({ view, vehicle, showBars, nameOf }: { view: View; vehicle: Vehicle; showBars: boolean; nameOf: (channel: number) => string }) {
  // Front view: the car's left is on the picture's right; rear view: on its left.
  const leftFlip = view === "rear";
  const frunk = vehicle === "cybertruck";
  const lamps = LIGHT_SPOTS.filter((s) => s.view === view);
  const mirrorLamps = (channel: number) => lamps.filter((s) => ON_MIRROR.has(s.channel) && s.channel === channel);
  const windows = view === "front" ? CLOSURE.frontWindow : CLOSURE.rearWindow;
  return (
    <svg viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} role="img" aria-label={`${view} view`}>
      <Defs view={view} />
      <ellipse cx={200} cy={GROUND_Y - 4} rx={190} ry={14} fill={`url(#${id(view, "floor")})`} />
      {pools(view, showBars).map((pool, i) => (
        <ellipse
          key={i}
          className="pool"
          cx={pool.cx}
          cy={GROUND_Y}
          rx={pool.rx}
          ry={9}
          fill={`url(#${id(view, "pool", pool.color)})`}
          data-pool={pool.channels.join(",")}
          data-gain={pool.gain}
        />
      ))}

      {vehicle === "model-x" && (
        <>
          <FalconDoor channel={CLOSURE.falconDoor.left} flip={leftFlip} />
          <FalconDoor channel={CLOSURE.falconDoor.right} flip={!leftFlip} />
        </>
      )}

      <g className="body">
        <path className="body-shell" d={BODY.shell} />
        {(view === "front" || frunk) && <path className="glass windshield" data-glass d={BODY.glass} />}
        <rect className="bumper" x={BODY.bumper.x} y={BODY.bumper.y} width={BODY.bumper.w} height={BODY.bumper.h} rx={BODY.bumper.r} />
        {BODY.wheels.map((w, i) => (
          <rect key={i} className="wheel" x={w.x} y={w.y} width={w.w} height={w.h} rx={w.r} />
        ))}
        {view === "rear" && (
          <rect className="plate" x={BODY.plate.x} y={BODY.plate.y} width={BODY.plate.w} height={BODY.plate.h} rx={BODY.plate.r} />
        )}
      </g>
      <rect className="sheen" x={0} y={0} width={VIEW_WIDTH} height={VIEW_HEIGHT} fill={`url(#${id(view, "sheen")})`} clipPath={`url(#${id(view, "shell")})`} data-sheen="" />

      <SideWindow channel={windows.left} flip={leftFlip} view={view} />
      <SideWindow channel={windows.right} flip={!leftFlip} view={view} />
      {view === "rear" && !frunk && <Lid view={view} d={BODY.glass} hingeY={62} glass />}
      {view === "front" && frunk && <Lid view={view} d={LID_FRUNK} hingeY={97} glass={false} />}
      {view === "rear" && <ChargePort view={view} />}

      <Mirror channel={CLOSURE.mirror.left} flip={leftFlip}>
        {mirrorLamps(21).map((spot, i) => <Lamp key={i} spot={spot} view={view} nameOf={nameOf} />)}
      </Mirror>
      <Mirror channel={CLOSURE.mirror.right} flip={!leftFlip}>
        {mirrorLamps(22).map((spot, i) => <Lamp key={i} spot={spot} view={view} nameOf={nameOf} />)}
      </Mirror>

      {lamps
        .filter((s) => !ON_MIRROR.has(s.channel))
        .map((spot, i) => (
          <Lamp key={i} spot={spot} view={view} nameOf={nameOf} />
        ))}
      {showBars &&
        LIGHT_BARS.filter((b) => b.view === view).map((bar) => {
          const step = (bar.x1 - bar.x0) / bar.count;
          const width = Math.abs(step) * 0.8;
          return (
            <g key={bar.name}>
              {Array.from({ length: bar.count }, (_, i) => {
                const x = bar.x0 + step * (i + 0.5) - width / 2;
                const channel = bar.first + i;
                return (
                  <g key={channel}>
                    <title>{`${channel} · ${nameOf(channel)}`}</title>
                    <rect className="lens" x={x} y={bar.y} width={width} height={4} />
                    <rect className="lit" x={x} y={bar.y} width={width} height={4} fill={bar.color} filter={`url(#${id(view, "glow")})`} data-ch={channel} />
                  </g>
                );
              })}
            </g>
          );
        })}
    </svg>
  );
}

/** Everything the update touches, found once per drawing. */
interface Parts {
  lamps: { el: SVGElement; channel: number }[];
  halos: { el: SVGElement; channel: number }[];
  pools: { el: SVGElement; channels: number[]; gain: number }[];
  mirrors: { el: SVGElement; channel: number; pivot: [number, number] }[];
  falcons: { el: SVGElement; channel: number }[];
  windows: { el: SVGElement; channel: number }[];
  lids: { el: SVGElement; pivot: [number, number] }[];
  lidLights: SVGElement[];
  ports: { el: SVGElement; pivot: [number, number] }[];
  portLights: SVGElement[];
  sheens: { el: SVGElement; stops: SVGElement[]; view: View }[];
  glass: SVGElement[];
}

function findParts(root: HTMLElement): Parts {
  const all = (selector: string) => Array.from(root.querySelectorAll<SVGElement>(selector));
  const num = (el: SVGElement, key: string) => Number(el.dataset[key]);
  const pivot = (el: SVGElement) => (el.dataset.pivot ?? "0 0").split(" ").map(Number) as [number, number];
  return {
    lamps: all("[data-ch]").map((el) => ({ el, channel: num(el, "ch") })),
    halos: all("[data-halo]").map((el) => ({ el, channel: num(el, "halo") })),
    pools: all("[data-pool]").map((el) => ({ el, channels: (el.dataset.pool ?? "").split(",").map(Number), gain: num(el, "gain") })),
    mirrors: all("[data-mirror]").map((el) => ({ el, channel: num(el, "mirror"), pivot: pivot(el) })),
    falcons: all("[data-falcon]").map((el) => ({ el, channel: num(el, "falcon") })),
    windows: all("[data-window]").map((el) => ({ el, channel: num(el, "window") })),
    lids: all("[data-lid]").map((el) => ({ el, pivot: pivot(el) })),
    lidLights: all("[data-lid-light]"),
    ports: all("[data-port]").map((el) => ({ el, pivot: pivot(el) })),
    portLights: all("[data-port-light]"),
    sheens: all("[data-sheen]").map((el) => {
      const svg = el.ownerSVGElement;
      const view: View = svg?.getAttribute("aria-label")?.startsWith("rear") ? "rear" : "front";
      return { el, view, stops: Array.from(svg?.querySelectorAll<SVGElement>("[data-sheen-stop]") ?? []) };
    }),
    glass: all("[data-glass]"),
  };
}

/** Scales by `sx`, `sy` about a pivot point (SVG transform). */
const scaleAbout = ([px, py]: [number, number], sx: number, sy: number) =>
  `translate(${px} ${py}) scale(${sx.toFixed(3)} ${sy.toFixed(3)}) translate(${-px} ${-py})`;

/** Front and rear drawings of the car; lights and closures are updated imperatively for speed. */
export const CarView = forwardRef<CarViewHandle, Props>(function CarView({ showBars, vehicle, idle, nameOf }, ref) {
  const root = useRef<HTMLDivElement>(null);
  const parts = useRef<Parts | null>(null);

  // Light bars and Model X doors come and go with the vehicle; find the parts again.
  useEffect(() => {
    parts.current = null;
  }, [showBars, vehicle]);

  const update = (levels: Uint8Array | undefined) => {
    if (!root.current) return;
    parts.current ??= findParts(root.current);
    const p = parts.current;
    const at = (channel: number) => (levels ? (levels[channel - 1] ?? 0) / 255 : 0);

    for (const { el, channel } of p.lamps) el.style.opacity = at(channel).toFixed(3);
    for (const { el, channel } of p.halos) el.style.opacity = at(channel).toFixed(3);
    for (const { el, channels, gain } of p.pools) {
      el.style.opacity = (Math.max(...channels.map(at)) * gain).toFixed(3);
    }
    for (const { el, view, stops } of p.sheens) {
      const glow = bodyGlow(levels, view, showBars);
      // A hint of the lights on the paint, not a coat of their colour.
      el.style.opacity = (glow.intensity * 0.22).toFixed(3);
      for (const stop of stops) stop.style.stopColor = `rgb(${glow.rgb.join(",")})`;
    }

    for (const { el, channel, pivot } of p.mirrors) el.setAttribute("transform", scaleAbout(pivot, mirrorWidth(at(channel)), 1));
    for (const { el, channel } of p.falcons) el.setAttribute("transform", `rotate(${falconAngle(at(channel)).toFixed(2)})`);
    for (const { el, channel } of p.windows) {
      const top = 61 + (97 - 61) * (1 - windowGlass(at(channel)));
      el.setAttribute("y", top.toFixed(2));
      el.setAttribute("height", (97 - top).toFixed(2));
    }
    const lid = at(CLOSURE.liftgate);
    const pose = lidPose(lid);
    for (const { el, pivot } of p.lids) el.setAttribute("transform", `translate(0 ${-pose.lift}) ${scaleAbout(pivot, 1, pose.height)}`);
    for (const el of p.lidLights) el.style.opacity = Math.min(1, lid * 1.5).toFixed(3);
    const port = at(CLOSURE.chargePort);
    for (const { el, pivot } of p.ports) el.setAttribute("transform", scaleAbout(pivot, 1 - 0.85 * port, 1));
    const portColor = chargePortLight(port);
    for (const el of p.portLights) {
      el.style.opacity = portColor ? "1" : "0";
      if (portColor) el.style.color = portColor;
    }

    // Interior RGB lights the cabin glass.
    const rgb = (first: number) => (levels ? [levels[first - 1] ?? 0, levels[first] ?? 0, levels[first + 1] ?? 0] : [0, 0, 0]);
    const zones = [INTERIOR.display, ...INTERIOR.accents].map(rgb);
    const mix = [0, 1, 2].map((c) => Math.max(...zones.map((z) => z[c])));
    const brightest = Math.max(...mix);
    for (const el of p.glass) {
      el.style.fill = brightest > 0 ? `rgb(${mix.join(",")})` : "";
      el.style.fillOpacity = brightest > 0 ? (0.15 + (0.45 * brightest) / 255).toFixed(3) : "";
    }
  };

  useImperativeHandle(ref, () => ({ update }));

  // The demo: breathing lights until a show is loaded (steady with reduced motion).
  useEffect(() => {
    if (!idle) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let frame = 0;
    const tick = (now: number) => {
      update(idleLevels(now, still));
      frame = still ? 0 : requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      update(undefined);
    };
    // `update` reads refs and props of the current render.
  }, [idle, showBars, vehicle]);

  const views: View[] = ["front", "rear"];
  return (
    <div className={`car-views${idle ? " idle" : ""}`} ref={root}>
      {views.map((view) => (
        <figure key={`${view}-${vehicle}-${showBars}`} className="car-view">
          <CarSvg view={view} vehicle={vehicle} showBars={showBars} nameOf={nameOf} />
          <figcaption>{view === "front" ? "Front" : "Rear"}</figcaption>
        </figure>
      ))}
    </div>
  );
});
