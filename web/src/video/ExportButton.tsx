import { useEffect, useRef, useState } from "react";
import type { View } from "../car/layout";
import type { Show, Vehicle } from "../engine";
import type { Spot } from "../party/layouts";
import { exportVideo, inspectVideo } from "./export";
import { HEIGHT, WIDTH, carPlacement, drawFrame } from "./render";

interface Props {
  /** The previewed shows, one per car. */
  fleet: Show[];
  /** Their files: the export makes its own shows from them, so loading another show or vehicle
   *  meanwhile does not change it. */
  files: Uint8Array<ArrayBuffer>[];
  /** Previewed car (0-based). */
  car: number;
  bars: boolean;
  vehicle: Vehicle;
  layout: Spot[];
  title: string;
  songUrl: string | null;
}

/** Brightest colour channel (0–255) in a box of one car view, in view units, of the video frame
 *  at `timeMs`. */
type FrameBrightness = (timeMs: number, view: View, box: [number, number, number, number]) => number;

/** Development hooks for scripts/video-e2e.mjs and scripts/car-e2e.mjs. */
const devHooks = window as unknown as {
  __lsaVideo?: Blob;
  __lsaInspectVideo?: typeof inspectVideo;
  __lsaFrameBrightness?: FrameBrightness;
};
if (import.meta.env.DEV) devHooks.__lsaInspectVideo = inspectVideo;

/** Exports the preview and the song as a video file. */
export function ExportButton({ fleet, files, car, bars, vehicle, layout, title, songUrl }: Props) {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [crowd, setCrowd] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // Development: draws one video frame of the current preview and measures it.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    devHooks.__lsaFrameBrightness = (timeMs, view, [x0, y0, x1, y1]) => {
      const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
      const ctx = canvas.getContext("2d")!;
      const levelsByCar = fleet.map((s) => s.levelsAt(timeMs));
      drawFrame(ctx, { levelsByCar, car, bars, vehicle, crowd: null, title, timeMs, durationMs: fleet[car]?.durationMs ?? 0 });
      const { x, y, scale } = carPlacement(view);
      const data = ctx.getImageData(x + x0 * scale, y + y0 * scale, (x1 - x0) * scale, (y1 - y0) * scale).data;
      let brightest = 0;
      for (let i = 0; i < data.length; i += 4) brightest = Math.max(brightest, data[i], data[i + 1], data[i + 2]);
      return brightest;
    };
  }, [fleet, car, bars, vehicle, title]);

  async function start() {
    setError(null);
    setProgress(0);
    abort.current = new AbortController();
    try {
      const song = songUrl ? await (await fetch(songUrl)).blob() : null;
      // Development: ?exportSeconds=5 exports only the start (scripts/video-e2e.mjs).
      const limit = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get("exportSeconds")) : 0;
      const { blob, extension } = await exportVideo({
        files,
        car,
        bars,
        vehicle,
        crowd: crowd && layout.length > 0 ? layout : null,
        title,
        song,
        limitMs: limit > 0 ? limit * 1000 : undefined,
        onProgress: setProgress,
        signal: abort.current.signal,
      });
      if (import.meta.env.DEV) devHooks.__lsaVideo = blob;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${title.replace(/\.fseq$/i, "") || "light-show"}${extension}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setError(`Export failed: ${String(e)}`);
    } finally {
      setProgress(null);
      abort.current = null;
    }
  }

  return (
    <span className="export">
      {progress === null ? (
        <button className="secondary" onClick={() => void start()} disabled={fleet.length === 0}>
          Export video
        </button>
      ) : (
        <>
          <span>Exporting… {Math.round(progress * 100)}%</span>
          <button className="secondary" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        </>
      )}
      {layout.length > 0 && progress === null && (
        <label className="check">
          <input type="checkbox" checked={crowd} onChange={(e) => setCrowd(e.target.checked)} />
          <span>film the crowd layout</span>
        </label>
      )}
      {!songUrl && progress === null && fleet.length > 0 && <em>no song loaded: the video will be silent</em>}
      {error && <span className="error">{error}</span>}
    </span>
  );
}
