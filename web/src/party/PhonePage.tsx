import { useEffect, useRef, useState } from "react";
import { listenForTones } from "./calibrate";
import { ClockSync, startClockSync } from "./clock";
import { connect, type Connection, type ServerMsg, type Track } from "./connection";

const COLORS: Record<string, [number, number, number]> = {
  white: [255, 244, 220],
  amber: [255, 174, 26],
  red: [255, 43, 43],
};

type Status = "intro" | "connecting" | "joined" | "ended";

interface Role {
  channel: number | null;
  label: string | null;
  color: string | null;
}

interface Playback {
  playing: boolean;
  t0: number | null;
  positionMs: number;
}

/** This tab's place in a room, kept across reloads so the phone gets its light back. */
const SESSION_KEY = "lsa-phone-session";

function savedToken(room: string): string | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null") as { room: string; token: string } | null;
    return saved?.room === room ? saved.token : null;
  } catch {
    return null;
  }
}

function saveToken(room: string, token: string | null) {
  try {
    if (token) sessionStorage.setItem(SESSION_KEY, JSON.stringify({ room, token }));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Private mode: the phone just joins as new after a reload.
  }
}

/** Keeps the screen awake where supported (needs HTTPS on most phones). */
async function keepAwake(): Promise<(() => void) | null> {
  try {
    const lock = await navigator.wakeLock?.request("screen");
    return lock ? () => void lock.release() : null;
  } catch {
    return null;
  }
}

/** Android Chrome can drive the camera flash; iPhone browsers cannot. */
async function openTorch(): Promise<MediaStreamTrack | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    const track = stream.getVideoTracks()[0];
    const capabilities = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
    if (!capabilities.torch) {
      track.stop();
      return null;
    }
    return track;
  } catch {
    return null;
  }
}

export function PhonePage() {
  const params = new URLSearchParams(location.search);
  const [room, setRoom] = useState((params.get("room") ?? "").toUpperCase());
  const [status, setStatus] = useState<Status>("intro");
  const [role, setRole] = useState<Role>({ channel: null, label: null, color: null });
  const [message, setMessage] = useState<string | null>(null);
  const [synced, setSynced] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [useTorch, setUseTorch] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState<boolean | null>(null);
  const [useMic, setUseMic] = useState(false);
  const [listening, setListening] = useState(false);
  const audioContext = useRef<AudioContext | null>(null);

  const screen = useRef<HTMLDivElement>(null);
  const connection = useRef<Connection | null>(null);
  const clock = useRef<ClockSync | null>(null);
  const track = useRef<Track | null>(null);
  const playback = useRef<Playback>({ playing: false, t0: null, positionMs: 0 });
  const roleRef = useRef<Role>(role);
  const torch = useRef<MediaStreamTrack | null>(null);
  const torchOn = useRef(false);
  const cleanup = useRef<(() => void)[]>([]);

  useEffect(() => () => cleanup.current.forEach((fn) => fn()), []);

  // Development: ?autojoin=1 joins without a tap (used by scripts/party-e2e.mjs).
  useEffect(() => {
    if (import.meta.env.DEV && params.get("autojoin")) void join();
    // Runs once on mount.
  }, []);

  const joining = useRef(false);

  async function join() {
    // Never open a second connection (double taps, React StrictMode re-running effects).
    if (!room.trim() || joining.current) return;
    joining.current = true;
    setStatus("connecting");
    setMessage(null);
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
    const release = await keepAwake();
    if (release) cleanup.current.push(release);
    if (useMic) {
      // Made during the tap (browsers only start audio from one); the permission is asked now so
      // the measurement later does not wait on a prompt.
      const ctx = new AudioContext();
      audioContext.current = ctx;
      cleanup.current.push(() => void ctx.close());
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        audioContext.current = null;
      }
    }
    if (useTorch) {
      torch.current = await openTorch();
      setTorchAvailable(!!torch.current);
      if (torch.current) cleanup.current.push(() => torch.current?.stop());
    }

    const code = room.trim();
    let token = savedToken(code);
    const conn = connect({
      // Every (re)connect takes back this phone's place, or joins as new.
      onOpen: () => {
        setReconnecting(false);
        conn.send(token ? { t: "resume", token } : { t: "join", room: code });
      },
      onMessage: (msg: ServerMsg) => {
        switch (msg.t) {
          case "sync":
            clock.current?.onReply(msg.c0, msg.s1);
            setSynced(!!clock.current?.ready);
            break;
          case "joined":
            token = msg.token;
            saveToken(code, token);
            setStatus("joined");
            break;
          case "resumed":
            setMessage(null);
            setStatus("joined");
            break;
          case "expired":
            // The place was given up (away too long, or the server restarted): join as new.
            token = null;
            saveToken(code, null);
            clock.current?.reset();
            conn.send({ t: "join", room: code });
            break;
          case "role":
            roleRef.current = { channel: msg.channel, label: msg.label, color: msg.color };
            setRole(roleRef.current);
            if (msg.channel === null) track.current = null;
            break;
          case "playback":
            playback.current = { playing: msg.playing, t0: msg.t0, positionMs: msg.positionMs };
            break;
          case "calibrate":
            if (audioContext.current && clock.current?.ready) {
              const sync = clock.current;
              setListening(true);
              void listenForTones(audioContext.current, () => sync.serverNow(), msg).then((delayMs) => {
                setListening(false);
                conn.send({ t: "heard", delayMs });
              });
            }
            break;
          case "error":
            setMessage(msg.message);
            if (msg.message.includes("ended")) {
              saveToken(code, null);
              conn.close();
              setStatus("ended");
            } else if (msg.message.includes("not found")) {
              // Wrong code: close this connection and let the user try again.
              conn.close();
              joining.current = false;
              setStatus("intro");
            }
            break;
          default:
            break;
        }
      },
      onTrack: (t) => {
        track.current = t;
        // Development: the governed track as received, read by scripts/party-e2e.mjs.
        if (import.meta.env.DEV) (window as unknown as { __lsaTrack: Track }).__lsaTrack = t;
      },
      // The light keeps playing from the track and schedule it has while this reconnects.
      onClose: () => setReconnecting(true),
    });
    connection.current = conn;
    cleanup.current.push(() => conn.close());
    // One clock for the whole session: the server's clock does not change across reconnects.
    const sync = new ClockSync((m) => conn.send(m));
    clock.current = sync;
    cleanup.current.push(startClockSync(sync));
  }

  // Light loop: one level lookup per screen refresh.
  useEffect(() => {
    if (status !== "joined") return;
    let frame = 0;
    let lastOn: boolean | null = null;
    // Development: on/off changes (crossing half brightness) on the shared clock, read by
    // scripts/party-e2e.mjs.
    const transitions: { server: number; level: number }[] = [];
    if (import.meta.env.DEV) (window as unknown as { __lsaTransitions: typeof transitions }).__lsaTransitions = transitions;
    const tick = () => {
      const el = screen.current;
      const sync = clock.current;
      const t = track.current;
      const { playing, t0, positionMs } = playback.current;
      let level = 0;
      if (t && sync?.ready) {
        // While playing, hold at the start position until the start lead has passed.
        const position =
          playing && t0 !== null ? Math.max(positionMs, sync.serverNow() - t0) : positionMs;
        const index = Math.floor(position / t.stepMs);
        level = index >= 0 && index < t.levels.length ? t.levels[index] : 0;
      }
      const on = level >= 128;
      if (import.meta.env.DEV && on !== lastOn && sync?.ready) {
        transitions.push({ server: sync.serverNow(), level: on ? 255 : 0 });
      }
      lastOn = on;
      const [r, g, b] = COLORS[roleRef.current.color ?? "white"] ?? COLORS.white;
      const k = level / 255;
      if (el) el.style.backgroundColor = `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;

      const wantTorch = level >= 128;
      if (torch.current && wantTorch !== torchOn.current) {
        torchOn.current = wantTorch;
        void torch.current
          .applyConstraints({ advanced: [{ torch: wantTorch } as MediaTrackConstraintSet] })
          .catch(() => undefined);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [status]);

  if (status === "intro" || status === "connecting") {
    return (
      <div className="phone-intro">
        <h1>Light Show Anywhere</h1>
        <p>Your phone becomes one light of the car.</p>
        <label>
          <span>Room code</span>
          <input
            value={room}
            onChange={(e) => setRoom(e.target.value.toUpperCase())}
            maxLength={4}
            autoCapitalize="characters"
            inputMode="text"
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={useTorch} onChange={(e) => setUseTorch(e.target.checked)} />
          <span>Also use the flashlight (Android)</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={useMic} onChange={(e) => setUseMic(e.target.checked)} />
          <span>Help tune the sound (uses the microphone only while the host measures; nothing is recorded or sent)</span>
        </label>
        <p className="safety">
          ⚠ This show contains flashing lights (limited to 3 flashes a second). If you are sensitive to flashing
          light, please do not join.
        </p>
        {message && <p className="error">{message}</p>}
        <button onClick={() => void join()} disabled={status === "connecting" || room.trim().length < 4}>
          {status === "connecting" ? "Joining…" : "Join the show"}
        </button>
      </div>
    );
  }

  if (status === "ended") {
    return (
      <div className="phone-intro">
        <h1>Show over</h1>
        <p>{message ?? "Disconnected."}</p>
        <button onClick={() => location.reload()}>Join again</button>
      </div>
    );
  }

  return (
    <div className="phone-light" ref={screen}>
      <div className="phone-label">
        <strong>{role.label ?? "Waiting for a light…"}</strong>
        <span>
          Room {room} · {reconnecting ? "reconnecting…" : synced ? "synced" : "syncing…"}
          {listening && " · listening to the speaker…"}
          {torchAvailable === false && " · no flashlight"}
          {!window.isSecureContext && " · screen may sleep (not HTTPS)"}
        </span>
        {message && <span className="error">{message}</span>}
      </div>
    </div>
  );
}
