import { forwardRef, useImperativeHandle, useRef } from "react";
import { CLOSURE_CHANNELS } from "./layout";

export interface ClosurePanelHandle {
  update(levels: Uint8Array | undefined): void;
}

/** Doors, windows, mirrors, liftgate and charge port: how open each one is. */
export const ClosurePanel = forwardRef<ClosurePanelHandle, { nameOf: (channel: number) => string }>(
  function ClosurePanel({ nameOf }, ref) {
    const bars = useRef<(HTMLDivElement | null)[]>([]);

    useImperativeHandle(ref, () => ({
      update(levels) {
        CLOSURE_CHANNELS.forEach((channel, i) => {
          const bar = bars.current[i];
          if (!bar) return;
          const open = levels ? (levels[channel - 1] ?? 0) / 255 : 0;
          bar.style.transform = `scaleX(${open.toFixed(3)})`;
        });
      },
    }));

    return (
      <section className="closures" aria-label="Closures">
        {CLOSURE_CHANNELS.map((channel, i) => (
          <div key={channel} className="closure">
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
