import { forwardRef, useState } from "react";
import { lightGroups, type View } from "../car/layout";
import { LayoutView, type LayoutViewHandle } from "./LayoutView";
import { MAX_SPOTS, circle, grid, line, mapLights, type Place, type Spot } from "./layouts";

type Shape = "grid" | "line" | "circle";

interface Props {
  spots: Spot[];
  onChange: (spots: Spot[]) => void;
  /** Cars in the loaded show. */
  cars: number;
  /** Cybertruck light bars are in the show (200 channels). */
  bars: boolean;
  nameOf: (channel: number) => string;
}

/** Crowd layouts: where phones stand and what each place plays. Empty means the car shape. */
export const LayoutPanel = forwardRef<LayoutViewHandle, Props>(function LayoutPanel(
  { spots, onChange, cars, bars, nameOf },
  ref,
) {
  const [shape, setShape] = useState<Shape>("grid");
  const [cols, setCols] = useState(8);
  const [rows, setRows] = useState(4);
  const [count, setCount] = useState(16);
  const [view, setView] = useState<View>("front");
  const [selected, setSelected] = useState<number | null>(null);

  const places = (): Place[] => (shape === "grid" ? grid(cols, rows) : shape === "line" ? line(count) : circle(count));
  const make = () => {
    setSelected(null);
    onChange(mapLights(places().slice(0, MAX_SPOTS), view, cars, bars));
  };
  const update = (index: number, change: Partial<Spot>) =>
    onChange(spots.map((spot, i) => (i === index ? { ...spot, ...change } : spot)));
  const remove = (index: number) => {
    setSelected(null);
    onChange(spots.filter((_, i) => i !== index));
  };
  const number = (value: string, max: number) => Math.min(max, Math.max(1, Math.round(Number(value)) || 1));
  const spot = selected === null ? null : spots[selected];
  const missing = spots.filter((s) => s.car > cars).length;

  return (
    <section className="layout">
      <div className="layout-controls">
        <h2>Crowd layout</h2>
        <p className="hint">
          {spots.length === 0
            ? "Phones form the car's lights. Or make a layout: phones stand in a shape, each place showing the nearest light of the car picture."
            : `${spots.length} places. Drag a place to move it, double-click to add one, Delete removes the selected one. Phones show where to stand.`}
        </p>
        <div className="layout-make">
          <select value={shape} onChange={(e) => setShape(e.target.value as Shape)} aria-label="Shape">
            <option value="grid">Grid</option>
            <option value="line">Line</option>
            <option value="circle">Circle</option>
          </select>
          {shape === "grid" ? (
            <>
              <input type="number" value={cols} min={1} max={64} onChange={(e) => setCols(number(e.target.value, 64))} aria-label="Columns" />
              ×
              <input type="number" value={rows} min={1} max={64} onChange={(e) => setRows(number(e.target.value, 64))} aria-label="Rows" />
            </>
          ) : (
            <input type="number" value={count} min={1} max={MAX_SPOTS} onChange={(e) => setCount(number(e.target.value, MAX_SPOTS))} aria-label="Places" />
          )}
          <select value={view} onChange={(e) => setView(e.target.value as View)} aria-label="Car view">
            <option value="front">Front of the car</option>
            <option value="rear">Rear of the car</option>
          </select>
          <button onClick={make}>{spots.length === 0 ? "Make layout" : "Make again"}</button>
          {spots.length > 0 && (
            <button className="secondary" onClick={() => onChange([])}>
              Use the car shape
            </button>
          )}
        </div>
        {missing > 0 && (
          <p className="warn">
            {missing} places play a car this show doesn't have, so they stay dark. Make the layout again.
          </p>
        )}
        {spot && selected !== null && (
          <div className="layout-place">
            <strong>Place {selected + 1}</strong>
            {cars > 1 && (
              <select value={spot.car} onChange={(e) => update(selected, { car: Number(e.target.value) })} aria-label="Car">
                {Array.from({ length: cars }, (_, i) => (
                  <option key={i} value={i + 1}>
                    Car {i + 1}
                  </option>
                ))}
              </select>
            )}
            <select value={spot.channel} onChange={(e) => update(selected, { channel: Number(e.target.value) })} aria-label="Light">
              {lightGroups(bars).flatMap((group) => group.channels).map((channel) => (
                <option key={channel} value={channel}>
                  {nameOf(channel)}
                </option>
              ))}
            </select>
            <button className="secondary" onClick={() => remove(selected)}>
              Delete
            </button>
          </div>
        )}
      </div>
      {spots.length > 0 && (
        <LayoutView
          ref={ref}
          spots={spots}
          selected={selected}
          onSelect={setSelected}
          onMove={(i, x, y) => update(i, { x, y })}
          onAdd={(x, y) => {
            if (spots.length >= MAX_SPOTS) return;
            onChange([...spots, ...mapLights([{ x, y }], view, cars, bars)]);
            setSelected(spots.length);
          }}
          onDelete={remove}
        />
      )}
    </section>
  );
});
