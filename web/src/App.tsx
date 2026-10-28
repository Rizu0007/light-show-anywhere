import { useCallback, useEffect, useRef, useState } from "react";
import { CarView, type CarViewHandle } from "./car/CarView";
import { ClosurePanel, type ClosurePanelHandle } from "./car/ClosurePanel";
import { Show, VEHICLES, channelName, loadEngine, type Vehicle } from "./engine";
import { HostPanel } from "./party/HostPanel";
import { useHost } from "./party/useHost";
import { useSyncedAudio } from "./party/useSyncedAudio";

const UI_UPDATE_MS = 100;
const SPEAKER_DELAY_KEY = "lsa.speakerDelayMs";

function storedSpeakerDelay(): number {
  try {
    return Number(localStorage.getItem(SPEAKER_DELAY_KEY)) || 0;
  } catch {
    return 0;
  }
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function App() {
  const [engineReady, setEngineReady] = useState(false);
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

  const car = useRef<CarViewHandle>(null);
  const closures = useRef<ClosurePanelHandle>(null);
  const audio = useRef<HTMLAudioElement>(null);
  // Clock used when no song is loaded: time = offset + (now - startedAt).
  const clock = useRef({ offsetMs: 0, startedAt: 0 });
  const showBytes = useRef<Uint8Array<ArrayBuffer> | null>(null);

  const party = useHost();
  const [speakerDelayMs, setSpeakerDelayMs] = useState(storedSpeakerDelay);
  useSyncedAudio(audio, party, speakerDelayMs, audioUrl);
  const isPlaying = party.active ? party.playback.playing : playing;

  function changeSpeakerDelay(ms: number) {
    setSpeakerDelayMs(ms);
    try {
      localStorage.setItem(SPEAKER_DELAY_KEY, String(ms));
    } catch {
      // Storage may be unavailable (private mode); the setting just isn't remembered.
    }
  }

  // Send the current show to the party whenever it, the vehicle, or the party changes.
  const partyLoad = useRef(party.load);
  partyLoad.current = party.load;
  useEffect(() => {
    if (party.active && show && showBytes.current) partyLoad.current(showBytes.current, vehicle, showName);
  }, [party.active, show, vehicle, showName]);

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
    // Runs once when the engine is ready.
  }, [engineReady]);

  const currentMs = useCallback((): number => {
    if (party.active) return party.positionNow();
    if (audio.current && audioUrl) return audio.current.currentTime * 1000;
    const { offsetMs, startedAt } = clock.current;
    return playing ? offsetMs + (performance.now() - startedAt) : offsetMs;
  }, [audioUrl, playing, party.active, party.positionNow]);

  // Render loop: one emulated frame per screen refresh.
  useEffect(() => {
    if (!show) return;
    let frame = 0;
    let lastUi = 0;
    const tick = (now: number) => {
      const ms = currentMs();
      const levels = show.levelsAt(ms);
      car.current?.update(levels);
      closures.current?.update(levels);
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
  }, [show, playing, currentMs, revision, party.active]);

  async function loadFiles(files: FileList | File[], forVehicle: Vehicle = vehicle) {
    setError(null);
      for (const file of Array.from(files)) {
        const name = file.name.toLowerCase();
        if (name.endsWith(".fseq")) {
          try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const next = new Show(bytes, forVehicle);
            showBytes.current = bytes;
            setShow((previous) => {
              previous?.free();
              return next;
            });
            setShowName(file.name);
            setIssues(next.teslaIssues());
            seek(startAt.current);
            startAt.current = 0;
          } catch (e) {
            setError(`Could not read ${file.name}: ${String(e)}`);
          }
        } else if (/\.(wav|mp3|m4a|ogg|flac)$/.test(name)) {
          setAudioUrl((previous) => {
            if (previous) URL.revokeObjectURL(previous);
            return URL.createObjectURL(file);
          });
          setAudioName(file.name);
        } else {
          setError(`Unsupported file: ${file.name} (use .fseq and .wav/.mp3)`);
        }
      }
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
    if (show) {
      show.setVehicle(next);
      setRevision((r) => r + 1);
    }
  }

  const channelCount = show?.channelCount ?? 200;
  const nameOf = useCallback(
    (channel: number) => (engineReady ? channelName(channel - 1, channelCount) : `Channel ${channel}`),
    [engineReady, channelCount],
  );
  const showBars = vehicle === "cybertruck" && channelCount > 48;
  const duration = show?.durationMs ?? 0;

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void loadFiles(e.dataTransfer.files);
      }}
    >
      <header>
        <h1>Light Show Anywhere</h1>
        <p className="tagline">Play any Tesla light show — no Tesla needed.</p>
      </header>

      <section className="controls">
        <label className="file">
          <span>Show (.fseq)</span>
          <input
            type="file"
            accept=".fseq"
            disabled={!engineReady}
            onChange={(e) => e.target.files && void loadFiles(e.target.files)}
          />
          <em>{showName || "none"}</em>
        </label>
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
        <p className="hint">Drop a Tesla light show (.fseq) and its song here, or choose files above.</p>
      )}

      <CarView ref={car} showBars={showBars} nameOf={nameOf} />

      <section className="transport">
        <button onClick={isPlaying ? pause : play} disabled={!show}>
          {isPlaying ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={duration}
          step={10}
          value={Math.min(timeMs, duration)}
          disabled={!show}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Position"
        />
        <span className="time">
          {formatTime(timeMs)} / {formatTime(duration)}
        </span>
      </section>

      {show && (
        <section className="info">
          <span>
            {show.channelCount} channels · {show.frameCount} frames · {show.stepMs} ms
          </span>
          {show.mediaFilename && <span>Made for: {show.mediaFilename}</span>}
          {issues.length === 0 ? (
            <span className="ok">✓ Plays on a real Tesla</span>
          ) : (
            issues.map((issue) => (
              <span key={issue} className="warn">
                ⚠ {issue}
              </span>
            ))
          )}
        </section>
      )}

      <HostPanel
        party={party}
        hasShow={!!show}
        nameOf={nameOf}
        speakerDelayMs={speakerDelayMs}
        onSpeakerDelay={changeSpeakerDelay}
      />

      <ClosurePanel ref={closures} nameOf={nameOf} />

      {audioUrl && <audio ref={audio} src={audioUrl} preload="auto" onEnded={() => !party.active && setPlaying(false)} />}
    </div>
  );
}
