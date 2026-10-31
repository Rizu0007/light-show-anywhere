import { forwardRef, useImperativeHandle, useRef, useState, type PointerEvent } from "react";
import { CHANNEL_COLORS, COLORS } from "../car/layout";
import type { Spot } from "./layouts";

const WIDTH = 1000;
const HEIGHT = 600;

export interface LayoutViewHandle {
  /** Lights every place from its car's levels (car 1 first). */
  update(levelsByCar: (Uint8Array | undefined)[]): void;
}

interface Props {
  spots: Spot[];
  selected: number | null;
  onSelect: (index: number | null) => void;
  onMove: (index: number, x: number, y: number) => void;
  onAdd: (x: number, y: number) => void;
  onDelete: (index: number) => void;
}

const colorOf = (channel: number) => CHANNEL_COLORS.get(channel) ?? COLORS.white;

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** The crowd as seen by the audience: one dot per place, lit like its light. Drag to move a place,
 *  double-click to add one, Delete to remove the selected one. */
export const LayoutView = forwardRef<LayoutViewHandle, Props>(function LayoutView(
  { spots, selected, onSelect, onMove, onAdd, onDelete },
  ref,
) {
  const svg = useRef<SVGSVGElement>(null);
  const lit = useRef<(SVGCircleElement | null)[]>([]);
  const [drag, setDrag] = useState<{ index: number; x: number; y: number; moved: boolean } | null>(null);
  const radius = Math.max(5, Math.min(26, 300 / Math.sqrt(Math.max(1, spots.length))));

  useImperativeHandle(ref, () => ({
    update(levelsByCar) {
      spots.forEach((spot, i) => {
        const el = lit.current[i];
        const level = levelsByCar[spot.car - 1]?.[spot.channel - 1] ?? 0;
        if (el) el.style.opacity = (level / 255).toFixed(3);
      });
    },
  }));

  const toLayout = (event: PointerEvent | React.MouseEvent) => {
    const box = svg.current!.getBoundingClientRect();
    return { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) };
  };

  return (
    <svg
      ref={svg}
      className="layout-view"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      tabIndex={0}
      role="img"
      aria-label="Crowd layout"
      onPointerDown={(e) => e.target === svg.current && onSelect(null)}
      onDoubleClick={(e) => {
        const { x, y } = toLayout(e);
        onAdd(x, y);
      }}
      onKeyDown={(e) => {
        if ((e.key === "Delete" || e.key === "Backspace") && selected !== null) onDelete(selected);
      }}
    >
      <text x={WIDTH / 2} y={HEIGHT - 12} className="layout-stage">
        audience side
      </text>
      {spots.map((spot, i) => {
        const at = drag?.index === i ? drag : spot;
        const cx = at.x * WIDTH;
        const cy = at.y * HEIGHT;
        return (
          <g
            key={i}
            className={i === selected ? "place selected" : "place"}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              setDrag({ index: i, x: spot.x, y: spot.y, moved: false });
              onSelect(i);
            }}
            onPointerMove={(e) => drag?.index === i && setDrag({ index: i, ...toLayout(e), moved: true })}
            onPointerUp={() => {
              if (drag?.index === i && drag.moved) onMove(i, drag.x, drag.y);
              setDrag(null);
            }}
          >
            <title>{`Place ${i + 1} · car ${spot.car} · channel ${spot.channel}`}</title>
            <circle cx={cx} cy={cy} r={radius} className="lens" />
            <circle
              ref={(el) => {
                lit.current[i] = el;
              }}
              cx={cx}
              cy={cy}
              r={radius}
              fill={colorOf(spot.channel)}
              className="lit"
            />
          </g>
        );
      })}
    </svg>
  );
});
