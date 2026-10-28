import { useCallback, useEffect, useRef, useState } from "react";
import { ClockSync, startClockSync } from "./clock";
import { connect, type Connection, type ServerMsg } from "./connection";

export interface RosterMember {
  id: number;
  name: string | null;
  channel: number | null;
}

export interface PartyPlayback {
  playing: boolean;
  t0: number | null;
  positionMs: number;
}

export interface HostParty {
  active: boolean;
  room: string | null;
  connected: boolean;
  synced: boolean;
  roster: RosterMember[];
  error: string | null;
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

  const conn = useRef<Connection | null>(null);
  const clock = useRef<ClockSync | null>(null);
  const stopSync = useRef<(() => void) | null>(null);
  const playbackRef = useRef(playback);
  // A show loaded before the room existed is uploaded once the room is created.
  const pendingLoad = useRef<{ bytes: Uint8Array<ArrayBuffer>; vehicle: string; name: string } | null>(null);

  const upload = useCallback((bytes: Uint8Array<ArrayBuffer>, vehicle: string, name: string) => {
    conn.current?.send({ t: "load", vehicle, name });
    conn.current?.sendBinary(bytes);
  }, []);

  const stop = useCallback(() => {
    stopSync.current?.();
    stopSync.current = null;
    conn.current?.close();
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
        const sync = new ClockSync((m) => connection.send(m));
        clock.current = sync;
        stopSync.current = startClockSync(sync);
        connection.send({ t: "create" });
      },
      onMessage: (msg: ServerMsg) => {
        switch (msg.t) {
          case "sync":
            clock.current?.onReply(msg.c0, msg.s1);
            setSynced(!!clock.current?.ready);
            break;
          case "created":
            setRoom(msg.room);
            if (pendingLoad.current) {
              const { bytes, vehicle, name } = pendingLoad.current;
              upload(bytes, vehicle, name);
            }
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
          case "error":
            setError(msg.message);
            break;
          default:
            break;
        }
      },
      onClose: () => {
        setConnected(false);
        conn.current = null;
        setError((e) => e ?? "Disconnected from the party server.");
      },
    });
    conn.current = connection;
  }, [upload]);

  useEffect(() => stop, [stop]);

  const load = useCallback(
    (bytes: Uint8Array<ArrayBuffer>, vehicle: string, name: string) => {
      pendingLoad.current = { bytes, vehicle, name };
      if (room) upload(bytes, vehicle, name);
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
  };
}
