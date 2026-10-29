/** Messages from the party server (see crates/lsa-server/src/protocol.rs). */
export type ServerMsg =
  | { t: "sync"; c0: number; s1: number }
  | { t: "created"; room: string; token: string }
  | { t: "joined"; id: number; room: string; token: string }
  | { t: "resumed"; id: number; room: string; host: boolean }
  | { t: "expired" }
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
  | { t: "roster"; members: { id: number; name: string | null; channel: number | null; online: boolean }[] }
  | { t: "calibrate"; at: number; tones: number; gapMs: number }
  | { t: "heard"; member: number; delayMs: number | null }
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
  /** Sends a JSON message; returns false (and drops it) while disconnected. */
  send(message: object): boolean;
  sendBinary(data: Uint8Array<ArrayBuffer>): boolean;
  /** Closes for good (no more reconnecting). */
  close(): void;
}

/** Development-only test hooks (scripts/party-e2e.mjs). */
const devHooks = window as unknown as { __lsaDrop?: () => void; __lsaOpens?: number };

const RETRY_MS = 500;
const RETRY_MAX_MS = 5000;
/** Clock sync replies arrive every 2 s; this long without any message means the link is dead. */
const SILENT_MS = 7000;

/**
 * Opens the party connection and keeps it open: after a drop it reconnects with backoff, and at
 * once when the page becomes visible again or the device comes back online (phones drop
 * sockets while the screen is locked). `onOpen` runs on every (re)connect, `onClose` on every
 * drop.
 */
export function connect(handlers: {
  onOpen: () => void;
  onMessage: (message: ServerMsg) => void;
  onTrack?: (track: Track) => void;
  onClose: () => void;
}): Connection {
  let ws: WebSocket | null = null;
  let closed = false;
  let retries = 0;
  let retryTimer = 0;
  let lastMessageAt = 0;

  const open = () => {
    clearTimeout(retryTimer);
    if (closed || ws) return;
    const socket = new WebSocket(serverUrl());
    ws = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      retries = 0;
      lastMessageAt = performance.now();
      if (import.meta.env.DEV) devHooks.__lsaOpens = (devHooks.__lsaOpens ?? 0) + 1;
      handlers.onOpen();
    };
    socket.onmessage = (event) => {
      lastMessageAt = performance.now();
      if (typeof event.data === "string") {
        handlers.onMessage(JSON.parse(event.data) as ServerMsg);
      } else {
        const track = parseTrack(event.data as ArrayBuffer);
        if (track) handlers.onTrack?.(track);
      }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      if (closed) return;
      handlers.onClose();
      retryTimer = window.setTimeout(open, Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** retries++));
    };
  };

  // A socket can stay "open" after Wi-Fi changes without ever closing; drop it if silent.
  const watchdog = window.setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN && performance.now() - lastMessageAt > SILENT_MS) {
      const dead = ws;
      dead.onclose?.(new CloseEvent("close"));
      dead.close();
    }
  }, 1000);
  const retryNow = () => {
    if (document.visibilityState !== "visible") return;
    retries = 0;
    open();
  };
  document.addEventListener("visibilitychange", retryNow);
  window.addEventListener("online", retryNow);
  // Development: lets scripts/party-e2e.mjs cut the connection.
  if (import.meta.env.DEV) devHooks.__lsaDrop = () => ws?.close();
  open();

  const ready = () => ws?.readyState === WebSocket.OPEN;
  return {
    send: (message) => {
      if (!ready()) return false;
      ws?.send(JSON.stringify(message));
      return true;
    },
    sendBinary: (data) => {
      if (!ready()) return false;
      ws?.send(data);
      return true;
    },
    close: () => {
      closed = true;
      clearTimeout(retryTimer);
      clearInterval(watchdog);
      document.removeEventListener("visibilitychange", retryNow);
      window.removeEventListener("online", retryNow);
      ws?.close();
      ws = null;
    },
  };
}
