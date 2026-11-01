import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CarView, type CarViewHandle } from "./car/CarView";
import { ClosurePanel, type ClosurePanelHandle } from "./car/ClosurePanel";
import { Timeline } from "./car/Timeline";
import { Show, VEHICLES, channelName, loadEngine, type Vehicle } from "./engine";
import { HostPanel } from "./party/HostPanel";
import { LayoutPanel } from "./party/LayoutPanel";
import type { LayoutViewHandle } from "./party/LayoutView";
import type { Spot } from "./party/layouts";
import { useHost } from "./party/useHost";
import { useSyncedAudio } from "./party/useSyncedAudio";
import { ExportButton } from "./video/ExportButton";

const UI_UPDATE_MS = 100;
const SEEK_STEP_MS = 5000;
const SPEAKER_DELAY_KEY = "lsa.speakerDelayMs";
const LAYOUT_KEY = "lsa.layout";
const SONG = /\.(wav|mp3|m4a|ogg|flac)$/i;
/** Most cars in a fleet show (lsa-server's MAX_CARS). */
const MAX_CARS = 16;

/** Keys typed into these are theirs, not shortcuts. */
const FORM_CONTROL = "input, select, textarea, [contenteditable]";

const PlayIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="icon">
    <path d="M4 2.5v11l9.5-5.5z" fill="currentColor" />
  </svg>
);
const PauseIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="icon">
    <path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" fill="currentColor" />
  </svg>
);

/** Path inside a picked folder ("The Arrival/Car #2/LightShow/lightshow.fseq"), else the name. */
const pathOf = (file: File) => file.webkitRelativePath || file.name;
const byPath = (a: File, b: File) => pathOf(a).localeCompare(pathOf(b), undefined, { numeric: true });

function storedSpeakerDelay(): number {
  try {
    return Number(localStorage.getItem(SPEAKER_DELAY_KEY)) || 0;
  } catch {
    return 0;
  }
}

function storedLayout(): Spot[] {
  try {
    const spots = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "[]") as unknown;
    return Array.isArray(spots) ? (spots as Spot[]) : [];
  } catch {
    return [];
  }
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function App() {
  const [engineReady, setEngineReady] = useState(false);
  // A fleet show has one Show per car (car 1 first); `show` is the car being previewed.
  const [fleet, setFleet] = useState<Show[]>([]);
  const [show, setShow] = useState<Show | null>(null);
  const [showName, setShowName] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioName, setAudioName] = useState("");
  const [vehicle, setVehicle] = useState<Vehicle>("model-3y");
  const [playing, setPlaying] = useState(false);
  const [timeMs, setTimeMs] = useState(0);
  const [issues, setIssues] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  // Files dragged over the page: enter/leave fire for every child, so count them.
  const [dragDepth, setDragDepth] = useState(0);

  const car = useRef<CarViewHandle>(null);
  const closures = useRef<ClosurePanelHandle>(null);
  const crowd = useRef<LayoutViewHandle>(null);
  const [layout, setLayout] = useState<Spot[]>(storedLayout);
  const audio = useRef<HTMLAudioElement>(null);
  // Clock used when no song is loaded: time = offset + (now - startedAt).
  const clock = useRef({ offsetMs: 0, startedAt: 0 });
  const showBytes = useRef<Uint8Array<ArrayBuffer>[]>([]);

  const party = useHost();
  const [speakerDelayMs, setSpeakerDelayMs] = useState(storedSpeakerDelay);
  useSyncedAudio(audio, party, speakerDelayMs, audioUrl);
  const isPlaying = party.active ? party.playback.playing : playing;

  function changeSpeakerDelay(ms: number) {
    setSpeakerDelayMs(ms);
    try {
      localStorage.setItem(SPEAKER_DELAY_KEY, String(ms));
    } catch {
      // Private mode: not remembered.
    }
  }

  function changeLayout(spots: Spot[]) {
    setLayout(spots);
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(spots));
    } catch {
      // Not remembered in private mode.
    }
  }

  const partyLayout = useRef(party.setLayout);
  partyLayout.current = party.setLayout;
  useEffect(() => {
    if (party.active) partyLayout.current(layout);
  }, [party.active, layout]);

  // Send the show to the party whenever it, the vehicle, or the party changes (not when the
  // previewed car changes: a new upload restarts the show for every phone).
  const partyLoad = useRef(party.load);
  partyLoad.current = party.load;
  useEffect(() => {
    if (party.active && fleet.length > 0) partyLoad.current(showBytes.current, vehicle, showName);
  }, [party.active, fleet, vehicle, showName]);

  useEffect(() => {
    loadEngine()
      .then(() => setEngineReady(true))
      .catch((e: unknown) => setError(`Engine failed to load: ${String(e)}`));
  }, []);

  // Development shortcut: ?show=<url>&song=<url>&t=<ms>&vehicle=<id> loads files without picking them.
  const startAt = useRef(0);
  useEffect(() => {
    if (!engineReady || !import.meta.env.DEV) return;
    const params = new URLSearchParams(location.search);
    const urls = [params.get("show"), params.get("song")].filter((u): u is string => !!u);
    if (urls.length === 0) return;
    startAt.current = Number(params.get("t") ?? 0) || 0;
    const requested = params.get("vehicle");
    if (requested && VEHICLES.some((v) => v.id === requested)) setVehicle(requested as Vehicle);
    Promise.all(
      urls.map(async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return new File([await response.blob()], url.split("/").pop() ?? "file");
      }),
    )
      .then((files) => loadFiles(files, (requested as Vehicle | null) ?? undefined))
      .catch((e: unknown) => setError(String(e)));
  }, [engineReady]);

  const currentMs = useCallback((): number => {
    if (party.active) return party.positionNow();
    if (audio.current && audioUrl) return audio.current.currentTime * 1000;
    const { offsetMs, startedAt } = clock.current;
    return playing ? offsetMs + (performance.now() - startedAt) : offsetMs;
  }, [audioUrl, playing, party.active, party.positionNow]);

  useEffect(() => {
    if (!show) return;
    let frame = 0;
    let lastUi = 0;
    const tick = (now: number) => {
      const ms = currentMs();
      const levels = show.levelsAt(ms);
      car.current?.update(levels);
      closures.current?.update(levels);
      if (layout.length > 0) crowd.current?.update(fleet.map((s) => (s === show ? levels : s.levelsAt(ms))));
      if (now - lastUi > UI_UPDATE_MS) {
        lastUi = now;
        setTimeMs(ms);
      }
      if (!party.active && playing && ms >= show.durationMs) {
        setPlaying(false);
        audio.current?.pause();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [show, fleet, playing, currentMs, revision, party.active, layout.length]);

  async function loadFiles(files: FileList | File[], forVehicle: Vehicle = vehicle) {
    setError(null);
    const all = Array.from(files);
    // A fleet show is one .fseq per car; Tesla names them all lightshow.fseq in "Car #1"… folders.
    const shows = all.filter((f) => f.name.toLowerCase().endsWith(".fseq")).sort(byPath);
    const song = all.filter((f) => SONG.test(f.name)).sort(byPath)[0];
    if (shows.length === 0 && !song) {
      setError(`Unsupported file: ${all[0]?.name ?? "none"} (use .fseq and .wav/.mp3)`);
      return;
    }
    if (shows.length > MAX_CARS) {
      setError(`At most ${MAX_CARS} cars per show (found ${shows.length} .fseq files)`);
      return;
    }
    if (shows.length > 0) {
      const next: Show[] = [];
      try {
        const bytes = await Promise.all(shows.map(async (f) => new Uint8Array(await f.arrayBuffer())));
        for (const b of bytes) next.push(new Show(b, forVehicle));
        showBytes.current = bytes;
        setFleet((previous) => {
          previous.forEach((s) => s.free());
          return next;
        });
        setShow(next[0]);
        setShowName(next.length > 1 ? pathOf(shows[0]).split("/")[0] || `${next.length}-car show` : shows[0].name);
        setIssues(next[0].teslaIssues());
        seek(startAt.current);
        startAt.current = 0;
      } catch (e) {
        next.forEach((s) => s.free());
        setError(`Could not read ${shows.map((f) => f.name).join(", ")}: ${String(e)}`);
      }
    }
    if (song) {
      setAudioUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return URL.createObjectURL(song);
      });
      setAudioName(song.name);
    }
  }

  function previewCar(index: number) {
    setShow(fleet[index]);
    setIssues(fleet[index].teslaIssues());
    setRevision((r) => r + 1);
  }

  function play() {
    if (!show) return;
    if (party.active) {
      const position = party.positionNow();
      party.play(position >= show.durationMs ? 0 : position);
      return;
    }
    if (currentMs() >= show.durationMs) seek(0);
    if (audio.current && audioUrl) {
      void audio.current.play();
    } else {
      clock.current.startedAt = performance.now();
    }
    setPlaying(true);
  }

  function pause() {
    if (party.active) {
      party.pause();
      return;
    }
    if (audio.current && audioUrl) {
      audio.current.pause();
    } else {
      clock.current.offsetMs = currentMs();
    }
    setPlaying(false);
  }

  function seek(ms: number) {
    if (party.active) {
      party.seek(ms);
      setTimeMs(ms);
      return;
    }
    if (audio.current && audioUrl) audio.current.currentTime = ms / 1000;
    clock.current = { offsetMs: ms, startedAt: performance.now() };
    setTimeMs(ms);
  }

  function changeVehicle(next: Vehicle) {
    setVehicle(next);
    if (fleet.length > 0) {
      fleet.forEach((s) => s.setVehicle(next));
      setRevision((r) => r + 1);
    }
  }

  // Keyboard: Space plays or pauses, the arrows jump, Home goes back to the start. The handler
  // is replaced every render so it always sees the current show and position.
  const shortcut = useRef<(event: KeyboardEvent) => void>(() => undefined);
  shortcut.current = (event) => {
    if (!show || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(FORM_CONTROL)) return;
    // A focused button (Play, after a click) presses itself on Space; the arrows still seek.
    if (event.key === " " && target?.closest("button")) return;
    const now = currentMs();
    if (event.key === " ") (isPlaying ? pause : play)();
    else if (event.key === "ArrowLeft") seek(Math.max(0, now - SEEK_STEP_MS));
    else if (event.key === "ArrowRight") seek(Math.min(show.durationMs, now + SEEK_STEP_MS));
    else if (event.key === "Home") seek(0);
    else return;
    event.preventDefault();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => shortcut.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const levelsAt = useMemo(() => (show ? (ms: number) => show.levelsAt(ms) : null), [show]);

  const channelCount = show?.channelCount ?? 200;
  const nameOf = useCallback(
    (channel: number) => (engineReady ? channelName(channel - 1, channelCount, vehicle) : `Channel ${channel}`),
    [engineReady, channelCount, vehicle],
  );
  const showBars = vehicle === "cybertruck" && channelCount > 48;
  const duration = show?.durationMs ?? 0;

  return (
    <div
      className="app"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files")) setDragDepth((d) => d + 1);
      }}
      onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        setDragDepth(0);
        void loadFiles(e.dataTransfer.files);
      }}
    >
      {dragDepth > 0 && (
        <div className="drop-overlay" aria-hidden="true">
          <div>
            <strong>Drop to load</strong>
            <span>a .fseq show, its song, or a fleet show's files</span>
          </div>
        </div>
      )}
      <header className="masthead">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>Light Show Anywhere</h1>
            <p className="tagline">Play any Tesla light show — no Tesla needed.</p>
          </div>
        </div>
        {show && <span className="now-showing">{showName}</span>}
      </header>

      <section className="controls">
        <label className="file">
          <span>Show (.fseq)</span>
          <input
            type="file"
            accept=".fseq"
            multiple
            disabled={!engineReady}
            onChange={(e) => e.target.files && void loadFiles(e.target.files)}
          />
          <em>{showName || "none"}</em>
        </label>
        <label className="file">
          <span>Fleet show (folder)</span>
          <input
            type="file"
            {...{ webkitdirectory: "" }}
            disabled={!engineReady}
            onChange={(e) => e.target.files && void loadFiles(e.target.files)}
          />
          <em>{fleet.length > 1 ? `${fleet.length} cars` : "one .fseq per car"}</em>
        </label>
        {fleet.length > 1 && (
          <label>
            <span>Preview car</span>
            <select value={fleet.indexOf(show as Show)} onChange={(e) => previewCar(Number(e.target.value))}>
              {fleet.map((_, i) => (
                <option key={i} value={i}>
                  Car {i + 1}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="file">
          <span>Song (.wav / .mp3)</span>
          <input
            type="file"
            accept="audio/*,.wav,.mp3"
            onChange={(e) => e.target.files && void loadFiles(e.target.files)}
          />
          <em>{audioName || "optional"}</em>
        </label>
        <label>
          <span>Vehicle</span>
          <select value={vehicle} onChange={(e) => changeVehicle(e.target.value as Vehicle)}>
            {VEHICLES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      {error && <p className="error">{error}</p>}
      {!show && !error && (
        <section className="empty">
          <strong>Drop a Tesla light show here</strong>
          <ol>
            <li>
              A <code>.fseq</code> show: Tesla's{" "}
              <a href="https://github.com/teslamotors/light-show" target="_blank" rel="noreferrer">
                examples
              </a>
              , or one made in xLights, LightCue or LightMyTesla.
            </li>
            <li>Its song (.wav or .mp3), so the lights play to the music.</li>
            <li>Press Play, or start a party and let phones become the lights.</li>
          </ol>
        </section>
      )}

      <CarView ref={car} showBars={showBars} vehicle={vehicle} idle={!show} nameOf={nameOf} />

      <section className="transport">
        <button className="play" onClick={isPlaying ? pause : play} disabled={!show}>
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
          {isPlaying ? "Pause" : "Play"}
        </button>
        <Timeline levelsAt={levelsAt} durationMs={duration} timeMs={timeMs} onSeek={seek} revision={revision} />
        <span className="time">
          {formatTime(timeMs)} / {formatTime(duration)}
        </span>
        {show && (
          <span className="keys" aria-label="Keyboard shortcuts: space plays or pauses, arrows jump 5 seconds">
            <kbd>Space</kbd> <kbd>←</kbd>
            <kbd>→</kbd>
          </span>
        )}
      </section>

      {show && (
        <section className="info">
          <span className="chip">
            {show.channelCount} channels · {show.frameCount} frames · {show.stepMs} ms
          </span>
          {fleet.length > 1 && <span className="chip">{fleet.length} cars</span>}
          {show.mediaFilename && <span className="chip">Made for: {show.mediaFilename}</span>}
          {issues.length === 0 ? (
            <span className="chip ok">✓ Plays on a real Tesla</span>
          ) : (
            issues.map((issue) => (
              <span key={issue} className="chip warn">
                ⚠ {issue}
              </span>
            ))
          )}
          <ExportButton
            fleet={fleet}
            car={Math.max(0, fleet.indexOf(show))}
            bars={showBars}
            vehicle={vehicle}
            layout={layout}
            title={showName}
            songUrl={audioUrl}
          />
        </section>
      )}

      <LayoutPanel
        ref={crowd}
        spots={layout}
        onChange={changeLayout}
        cars={Math.max(1, fleet.length)}
        bars={showBars}
        nameOf={nameOf}
      />

      <HostPanel
        party={party}
        hasShow={!!show}
        cars={Math.max(1, fleet.length)}
        bars={showBars}
        layout={layout}
        nameOf={nameOf}
        speakerDelayMs={speakerDelayMs}
        onSpeakerDelay={changeSpeakerDelay}
      />

      <ClosurePanel ref={closures} nameOf={nameOf} />

      {audioUrl && <audio ref={audio} src={audioUrl} preload="auto" onEnded={() => !party.active && setPlaying(false)} />}
    </div>
  );
}
