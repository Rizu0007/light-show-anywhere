import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  BODY,
  INTERIOR,
  LIGHT_BARS,
  LIGHT_SPOTS,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  type Shape,
  type View,
} from "./layout";

export interface CarViewHandle {
  /** Applies one frame of channel levels (0–255). Called every animation frame. */
  update(levels: Uint8Array | undefined): void;
}

interface Props {
  showBars: boolean;
  nameOf: (channel: number) => string;
}

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
  return (
    <ellipse
      cx={shape.cx}
      cy={shape.cy}
      rx={shape.rx}
      ry={shape.ry}
      {...(rest as React.SVGProps<SVGEllipseElement>)}
    />
  );
}

function Body({ view }: { view: View }) {
  const glass = view === "front" ? "windshield" : "rear-window";
  return (
    <g className="body">
      <path className="body-shell" d={BODY.shell} />
      <path className={`glass ${glass}`} data-glass d={BODY.glass} />
      <rect className="bumper" x={BODY.bumper.x} y={BODY.bumper.y} width={BODY.bumper.w} height={BODY.bumper.h} rx={BODY.bumper.r} />
      {BODY.wheels.map((w, i) => (
        <rect key={i} className="wheel" x={w.x} y={w.y} width={w.w} height={w.h} rx={w.r} />
      ))}
      {view === "rear" && (
        <rect className="plate" x={BODY.plate.x} y={BODY.plate.y} width={BODY.plate.w} height={BODY.plate.h} rx={BODY.plate.r} />
      )}
    </g>
  );
}

/** Front and rear drawings of the car; lights are updated imperatively for speed. */
export const CarView = forwardRef<CarViewHandle, Props>(function CarView({ showBars, nameOf }, ref) {
  const root = useRef<HTMLDivElement>(null);
  const byChannel = useRef<Map<number, SVGElement[]>>(new Map());
  const glass = useRef<SVGElement[]>([]);

  // Light bars appear or disappear with the vehicle; rebuild the element cache.
  useEffect(() => byChannel.current.clear(), [showBars]);

  useImperativeHandle(ref, () => ({
    update(levels) {
      if (!root.current) return;
      if (byChannel.current.size === 0) {
        root.current.querySelectorAll<SVGElement>("[data-ch]").forEach((el) => {
          const ch = Number(el.dataset.ch);
          const list = byChannel.current.get(ch) ?? [];
          list.push(el);
          byChannel.current.set(ch, list);
        });
        glass.current = Array.from(root.current.querySelectorAll<SVGElement>("[data-glass]"));
      }
      for (const [channel, elements] of byChannel.current) {
        const level = levels ? (levels[channel - 1] ?? 0) / 255 : 0;
        const opacity = level.toFixed(3);
        for (const el of elements) el.style.opacity = opacity;
      }
      // Interior RGB lights the cabin glass.
      const rgb = (first: number) =>
        levels ? [levels[first - 1] ?? 0, levels[first] ?? 0, levels[first + 1] ?? 0] : [0, 0, 0];
      const zones = [INTERIOR.display, ...INTERIOR.accents].map(rgb);
      const mix = [0, 1, 2].map((c) => Math.max(...zones.map((z) => z[c])));
      const brightest = Math.max(...mix);
      for (const el of glass.current) {
        el.style.fill = brightest > 0 ? `rgb(${mix.join(",")})` : "";
        el.style.fillOpacity = brightest > 0 ? (0.15 + (0.45 * brightest) / 255).toFixed(3) : "";
      }
    },
  }));

  const views: View[] = ["front", "rear"];
  return (
    <div className="car-views" ref={root}>
      {views.map((view) => (
        <figure key={view} className="car-view">
          <svg viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} role="img" aria-label={`${view} view`}>
            <defs>
              <filter id={`glow-${view}`} x="-50%" y="-200%" width="200%" height="500%">
                <feGaussianBlur stdDeviation="5" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <Body view={view} />
            {LIGHT_SPOTS.filter((s) => s.view === view).map((spot, i) => (
              <g key={i}>
                <title>{`${spot.channel} · ${nameOf(spot.channel)}`}</title>
                <ShapeEl shape={spot.shape} className="lens" />
                <ShapeEl
                  shape={spot.shape}
                  className="lit"
                  fill={spot.color}
                  filter={`url(#glow-${view})`}
                  data-ch={spot.channel}
                />
              </g>
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
                          <rect
                            className="lit"
                            x={x}
                            y={bar.y}
                            width={width}
                            height={4}
                            fill={bar.color}
                            filter={`url(#glow-${view})`}
                            data-ch={channel}
                          />
                        </g>
                      );
                    })}
                  </g>
                );
              })}
          </svg>
          <figcaption>{view === "front" ? "Front" : "Rear"}</figcaption>
        </figure>
      ))}
    </div>
  );
});
