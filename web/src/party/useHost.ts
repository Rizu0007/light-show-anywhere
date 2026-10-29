import { useCallback, useEffect, useRef, useState } from "react";
import { playTones } from "./calibrate";
import { ClockSync, startClockSync } from "./clock";
import { connect, type Connection, type ServerMsg } from "./connection";

export interface RosterMember {
  id: number;
  name: string | null;
  channel: number | null;
  /** False while the phone is away (it keeps its light for a couple of minutes). */
  online: boolean;
}

export interface PartyPlayback {
  playing: boolean;
  t0: number | null;
  positionMs: number;
}

/** A speaker measurement: tones played at `at`, and what each listening phone heard. */
export interface Calibration {
  at: number;
  heard: { member: number; delayMs: number | null }[];
}

export interface HostParty {
  active: boolean;
  room: string | null;
  connected: boolean;
  synced: boolean;
  roster: RosterMember[];
  error: string | null;
  /** Latest speaker measurement, if any. */
  calibration: Calibration | null;
  /** Latest playback state from the server. */
  playback: PartyPlayback;
  /** Show position right now on the shared clock (what every phone shows). */
  positionNow: () => number;
  /** Shared clock in milliseconds, or `null` before sync. */
  serverNow: () => number | null;
  start: () => void;
  stop: () => void;
  load: (bytes: Uint8Array<ArrayBuffer>, vehicle: string, name: string) => void;
  play: (positionMs: number) => void;
  pause: () => void;
  seek: (positionMs: number) => void;
  assign: (member: number, channel: number | null) => void;
  /** Plays calibration tones for phones with a microphone to measure (call from a click). */
  calibrate: () => void;
}

/** Hosts a party: owns the connection, the shared clock and the room's state. */
export function useHost(): HostParty {
  const [active, setActive] = useState(false);
  const [room, setRoom] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [synced, setSynced] = useState(false);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [playback, setPlayback] = useState<PartyPlayback>({ playing: false, t0: null, positionMs: 0 });
  const [calibration, setCalibration] = useState<Calibration | null>(null);
  const audioContext = useRef<AudioContext | null>(null);

  const conn = useRef<Connection | null>(null);
  const clock = useRef<ClockSync | null>(null);
  const stopSync = useRef<(() => void) | null>(null);
  const playbackRef = useRef(playback);
  // The latest show; uploaded when the room is created, and again after a reconnect if it was
  // loaded while offline.
  const pendingLoad = useRef<{ bytes: Uint8Array<ArrayBuffer>; vehicle: string; name: string } | null>(null);
  const needsUpload = useRef(false);
  // Lets a dropped connection take the room back (see lsa-server's resume).
  const token = useRef<string | null>(null);

  const upload = useCallback(() => {
    const show = pendingLoad.current;
    if (!show || !conn.current) return;
    const sent = conn.current.send({ t: "load", vehicle: show.vehicle, name: show.name });
    needsUpload.current = !(sent && conn.current.sendBinary(show.bytes));
  }, []);

  const stop = useCallback(() => {
    stopSync.current?.();
    stopSync.current = null;
    // Ends the party for every phone now, instead of after the server's grace period.
    conn.current?.send({ t: "leave" });
    conn.current?.close();
    token.current = null;
    conn.current = null;
    clock.current = null;
    setActive(false);
    setRoom(null);
    setConnected(false);
    setSynced(false);
    setRoster([]);
  }, []);

  const start = useCallback(() => {
    if (conn.current) return;
    setActive(true);
    setError(null);
    const connection = connect({
      onOpen: () => {
        setConnected(true);
        connection.send(token.current ? { t: "resume", token: token.current } : { t: "create" });
      },
      onMessage: (msg: ServerMsg) => {
        switch (msg.t) {
          case "sync":
            clock.current?.onReply(msg.c0, msg.s1);
            setSynced(!!clock.current?.ready);
            break;
          case "created":
            token.current = msg.token;
            setRoom(msg.room);
            setError(null);
            upload();
            break;
          case "resumed":
            setRoom(msg.room);
            setError(null);
            if (needsUpload.current) upload();
            break;
          case "expired":
            // Offline for longer than the server keeps a room.
            stop();
            setError("The party ended while this computer was offline. Start a new one.");
            break;
          case "playback": {
            const next = { playing: msg.playing, t0: msg.t0, positionMs: msg.positionMs };
            playbackRef.current = next;
            setPlayback(next);
            break;
          }
          case "roster":
            setRoster(msg.members);
            break;
          case "calibrate":
            setCalibration({ at: msg.at, heard: [] });
            if (audioContext.current && clock.current) {
              const sync = clock.current;
              void playTones(audioContext.current, () => sync.serverNow(), msg);
            }
            break;
          case "heard":
            setCalibration((c) =>
              c && {
                ...c,
                heard: [...c.heard.filter((h) => h.member !== msg.member), { member: msg.member, delayMs: msg.delayMs }],
              },
            );
            break;
          case "error":
            setError(msg.message);
            break;
          default:
            break;
        }
      },
      // Reconnects by itself; phones keep playing meanwhile.
      onClose: () => setConnected(false),
    });
    conn.current = connection;
    // One clock for the whole party: the server's clock does not change across reconnects.
    const sync = new ClockSync((m) => connection.send(m));
    clock.current = sync;
    stopSync.current = startClockSync(sync);
  }, [upload, stop]);

  useEffect(() => stop, [stop]);

  const load = useCallback(
    (bytes: Uint8Array<ArrayBuffer>, vehicle: string, name: string) => {
      pendingLoad.current = { bytes, vehicle, name };
      needsUpload.current = true;
      if (room) upload();
    },
    [room, upload],
  );

  const positionNow = useCallback(() => {
    const { playing, t0, positionMs } = playbackRef.current;
    if (playing && t0 !== null && clock.current) {
      return Math.max(positionMs, clock.current.serverNow() - t0);
    }
    return positionMs;
  }, []);

  const serverNow = useCallback(() => clock.current?.serverNow() ?? null, []);

  return {
    active,
    room,
    connected,
    synced,
    roster,
    error,
    calibration,
    playback,
    positionNow,
    serverNow,
    start,
    stop,
    load,
    play: (positionMs) => conn.current?.send({ t: "play", positionMs }),
    pause: () => conn.current?.send({ t: "pause" }),
    seek: (positionMs) => conn.current?.send({ t: "seek", positionMs }),
    assign: (member, channel) => conn.current?.send({ t: "assign", member, channel }),
    calibrate: () => {
      // Browsers only start audio from a click, so the context is made here.
      audioContext.current ??= new AudioContext();
      void audioContext.current.resume();
      conn.current?.send({ t: "calibrate" });
    },
  };
}
