import { useEffect, useMemo, useRef } from "react";
import { activity, type Activity } from "./scene";

/** Slices drawn across the timeline. */
const BUCKETS = 240;

interface Props {
  /** Channel levels at a show time, or `null` before a show is loaded. */
  levelsAt: ((ms: number) => ArrayLike<number> | undefined) | null;
  durationMs: number;
  timeMs: number;
  onSeek: (ms: number) => void;
  /** Changes when the levels do (another vehicle or car), so the shape is measured again. */
  revision: number;
}

/**
 * The seek bar, drawn as the show's shape: each slice as tall as how much is lit then, in the
 * colour of what is lit; played slices brighter. A native range input on top does the seeking, so
 * keyboard and screen readers work as before.
 */
export function Timeline({ levelsAt, durationMs, timeMs, onSeek, revision }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const shape = useMemo<Activity[]>(
    () => (levelsAt && durationMs > 0 ? activity(levelsAt, durationMs, BUCKETS) : []),
    // `revision` stands for changes inside `levelsAt`'s show.
    [levelsAt, durationMs, revision],
  );

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(el.clientWidth * ratio);
    const height = Math.round(el.clientHeight * ratio);
    if (el.width !== width || el.height !== height) {
      el.width = width;
      el.height = height;
    }
    ctx.clearRect(0, 0, width, height);
    const middle = height / 2;
    ctx.fillStyle = "#1d2430";
    ctx.fillRect(0, middle - ratio, width, 2 * ratio);
    const played = durationMs > 0 ? timeMs / durationMs : 0;
    const slice = width / BUCKETS;
    shape.forEach(({ intensity, rgb }, b) => {
      if (intensity <= 0) return;
      const half = Math.max(ratio, (intensity * (height - 2 * ratio)) / 2);
      const isPlayed = (b + 0.5) / BUCKETS <= played;
      ctx.fillStyle = `rgba(${rgb.join(",")},${isPlayed ? 0.95 : 0.35})`;
      ctx.fillRect(b * slice, middle - half, Math.max(ratio, slice - ratio), 2 * half);
    });
    if (durationMs > 0) {
      ctx.fillStyle = "#5aa0ff";
      ctx.fillRect(Math.min(width - 2 * ratio, played * width), 0, 2 * ratio, height);
    }
  }, [shape, timeMs, durationMs]);

  return (
    <div className="timeline">
      <canvas ref={canvas} aria-hidden="true" data-timeline={shape.filter((a) => a.intensity > 0).length} />
      <input
        type="range"
        min={0}
        max={durationMs}
        step={10}
        value={Math.min(timeMs, durationMs)}
        disabled={!levelsAt}
        onChange={(e) => onSeek(Number(e.target.value))}
        aria-label="Position"
      />
    </div>
  );
}
