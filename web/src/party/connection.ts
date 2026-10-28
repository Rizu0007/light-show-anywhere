/** Messages from the party server (see crates/lsa-server/src/protocol.rs). */
export type ServerMsg =
  | { t: "sync"; c0: number; s1: number }
  | { t: "created"; room: string }
  | { t: "joined"; id: number; room: string }
  | {
      t: "show";
      version: number;
      name: string;
      vehicle: string;
      stepMs: number;
      frameCount: number;
      durationMs: number;
    }
  | { t: "role"; channel: number | null; label: string | null; color: string | null }
  | { t: "playback"; playing: boolean; t0: number | null; positionMs: number }
  | { t: "roster"; members: { id: number; name: string | null; channel: number | null }[] }
  | { t: "error"; message: string };

/** A phone's light track (binary frame). */
export interface Track {
  version: number;
  channel: number;
  stepMs: number;
  levels: Uint8Array;
}

const TRACK_MAGIC = "LSAT";
const TRACK_HEADER_LEN = 12;

export function parseTrack(buffer: ArrayBuffer): Track | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < TRACK_HEADER_LEN) return null;
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== TRACK_MAGIC) return null;
  const view = new DataView(buffer);
  return {
    version: view.getUint32(4, true),
    channel: view.getUint16(8, true),
    stepMs: bytes[10],
    levels: bytes.slice(TRACK_HEADER_LEN),
  };
}

/** Same-origin WebSocket URL (the dev server proxies /ws to lsa-server). */
export function serverUrl(): string {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${location.host}/ws`;
}

export interface Connection {
  send(message: object): void;
  sendBinary(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
}

export function connect(handlers: {
  onOpen: () => void;
  onMessage: (message: ServerMsg) => void;
  onTrack?: (track: Track) => void;
  onClose: () => void;
}): Connection {
  const ws = new WebSocket(serverUrl());
  ws.binaryType = "arraybuffer";
  ws.onopen = handlers.onOpen;
  ws.onclose = handlers.onClose;
  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      handlers.onMessage(JSON.parse(event.data) as ServerMsg);
    } else {
      const track = parseTrack(event.data as ArrayBuffer);
      if (track) handlers.onTrack?.(track);
    }
  };
  return {
    send: (message) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(message)),
    sendBinary: (data) => ws.readyState === WebSocket.OPEN && ws.send(data),
    close: () => ws.close(),
  };
}
