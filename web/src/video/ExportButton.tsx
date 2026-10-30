import { useRef, useState } from "react";
import type { Show } from "../engine";
import type { Spot } from "../party/layouts";
import { exportVideo, inspectVideo } from "./export";

interface Props {
  fleet: Show[];
  /** Previewed car (0-based). */
  car: number;
  bars: boolean;
  layout: Spot[];
  title: string;
  songUrl: string | null;
}

/** Development hooks for scripts/video-e2e.mjs. */
const devHooks = window as unknown as { __lsaVideo?: Blob; __lsaInspectVideo?: typeof inspectVideo };
if (import.meta.env.DEV) devHooks.__lsaInspectVideo = inspectVideo;

/** Exports the preview and the song as a video file. */
export function ExportButton({ fleet, car, bars, layout, title, songUrl }: Props) {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [crowd, setCrowd] = useState(false);
  const abort = useRef<AbortController | null>(null);

  async function start() {
    setError(null);
    setProgress(0);
    abort.current = new AbortController();
    try {
      const song = songUrl ? await (await fetch(songUrl)).blob() : null;
      // Development: ?exportSeconds=5 exports only the start (scripts/video-e2e.mjs).
      const limit = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get("exportSeconds")) : 0;
      const { blob, extension } = await exportVideo({
        fleet,
        car,
        bars,
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
