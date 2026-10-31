import { forwardRef, useImperativeHandle, useRef } from "react";
import { CLOSURE_CHANNELS } from "./layout";

export interface ClosurePanelHandle {
  update(levels: Uint8Array | undefined): void;
}

/** Doors, windows, mirrors, liftgate and charge port: how open each one is. Rows that are open
 *  stand out; the car pictures show the same movement. */
export const ClosurePanel = forwardRef<ClosurePanelHandle, { nameOf: (channel: number) => string }>(
  function ClosurePanel({ nameOf }, ref) {
    const rows = useRef<(HTMLDivElement | null)[]>([]);
    const bars = useRef<(HTMLDivElement | null)[]>([]);

    useImperativeHandle(ref, () => ({
      update(levels) {
        CLOSURE_CHANNELS.forEach((channel, i) => {
          const open = levels ? (levels[channel - 1] ?? 0) / 255 : 0;
          const bar = bars.current[i];
          if (bar) bar.style.transform = `scaleX(${open.toFixed(3)})`;
          rows.current[i]?.classList.toggle("open", open > 0);
        });
      },
    }));

    return (
      <section className="closures" aria-label="Closures">
        <h3>Doors, windows &amp; mirrors</h3>
        {CLOSURE_CHANNELS.map((channel, i) => (
          <div
            key={channel}
            className="closure"
            ref={(el) => {
              rows.current[i] = el;
            }}
          >
            <span>{nameOf(channel)}</span>
            <div className="closure-track">
              <div
                className="closure-fill"
                ref={(el) => {
                  bars.current[i] = el;
                }}
              />
            </div>
          </div>
        ))}
      </section>
    );
  },
);
