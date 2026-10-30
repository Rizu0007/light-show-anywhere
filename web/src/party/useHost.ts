import { useCallback, useEffect, useRef, useState } from "react";
import { playTones } from "./calibrate";
import { ClockSync, startClockSync } from "./clock";
import { connect, type Connection, type PhoneHealth, type ServerMsg } from "./connection";
import type { Spot } from "./layouts";

export interface RosterMember {
  id: number;
  name: string | null;
  /** Place in the layout, if there is one. */
  spot: number | null;
  car: number | null;
  channel: number | null;
  /** False while the phone is away (it keeps its light for a couple of minutes). */
  online: boolean;
  /** The phone's last report, if any. */
  health: PhoneHealth | null;
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
  /** Uploads a show: one `.fseq`, or one per car of a fleet show (car 1 first). */
  load: (files: Uint8Array<ArrayBuffer>[], vehicle: string, name: string) => void;
  play: (positionMs: number) => void;
  pause: () => void;
  seek: (positionMs: number) => void;
  assign: (member: number, car: number, channel: number | null) => void;
  /** With a layout: moves a phone to a place (`null`: any place). */
  assignSpot: (member: number, spot: number | null) => void;
  /** Where phones stand; empty for the car shape. */
  setLayout: (spots: Spot[]) => void;
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
  const pendingLoad = useRef<{ files: Uint8Array<ArrayBuffer>[]; vehicle: string; name: string } | null>(null);
  const needsUpload = useRef(false);
  const layout = useRef<Spot[]>([]);
  const sendLayout = useCallback(() => conn.current?.send({ t: "layout", spots: layout.current }), []);
  // Lets a dropped connection take the room back (see lsa-server's resume).
  const token = useRef<string | null>(null);

  const upload = useCallback(() => {
    const show = pendingLoad.current;
    if (!show || !conn.current) return;
    // All cars in one frame, so phones are never dealt lights for half a fleet.
    const sizes = show.files.length > 1 ? show.files.map((f) => f.length) : [];
    const bytes = new Uint8Array(show.files.reduce((total, f) => total + f.length, 0));
    show.files.reduce((at, f) => (bytes.set(f, at), at + f.length), 0);
    const sent = conn.current.send({ t: "load", vehicle: show.vehicle, name: show.name, sizes });
    needsUpload.current = !(sent && conn.current.sendBinary(bytes));
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
    // Made on this click (browsers only start audio from one) rather than on Calibrate, so its
    // clock has settled by the time the speaker is measured (see calibrate.ts).
    audioContext.current ??= new AudioContext();
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
            // After the show: the server checks the layout's cars against it.
            if (layout.current.length > 0) sendLayout();
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
  }, [upload, stop, sendLayout]);

  useEffect(() => stop, [stop]);

  const load = useCallback(
    (files: Uint8Array<ArrayBuffer>[], vehicle: string, name: string) => {
      pendingLoad.current = { files, vehicle, name };
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
    assign: (member, car, channel) => conn.current?.send({ t: "assign", member, car, channel }),
    assignSpot: (member, spot) => conn.current?.send({ t: "assign", member, spot }),
    setLayout: (spots) => {
      layout.current = spots;
      // Before the room exists it is sent on "created", after the show.
      if (room) sendLayout();
    },
    calibrate: () => {
      // Browsers only start audio from a click, so the context is made here.
      audioContext.current ??= new AudioContext();
      void audioContext.current.resume();
      conn.current?.send({ t: "calibrate" });
    },
  };
}
