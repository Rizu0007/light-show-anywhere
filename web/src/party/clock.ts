/**
 * Estimates the server clock from ping/pong: keeps the lowest-round-trip sample and slews towards
 * it, so corrections never jump.
 *
 * Ported from Crowd Light Show's public/clocksync.js
 * (https://github.com/AndriiShramko/crowd-light-show), Copyright 2026 Andrii Shramko,
 * Apache License 2.0 (licenses/Apache-2.0.txt). Modified: TypeScript class, ping loop in
 * startClockSync(), telemetry removed. See NOTICE.
 */

const WINDOW = 40;
const MIN_SAMPLES = 8;
const MAX_READY_RTT_MS = 400;
const STABLE_MS = 30;
const FALLBACK_MS = 6000;
const SNAP_MS = 8;
const SLEW_PER_MS = 0.15;

interface Sample {
  offset: number;
  rtt: number;
}

export class ClockSync {
  private samples: Sample[] = [];
  private recentBest: number[] = [];
  private firstReplyAt = 0;
  private bestOffset = 0;
  private appliedOffset = 0;
  private haveOffset = false;
  private lastSlewAt = 0;

  ready = false;
  degraded = false;
  bestRtt = Infinity;

  constructor(private readonly send: (message: object) => void) {}

  ping(): void {
    this.send({ t: "sync", c0: performance.now() });
  }

  /** Handles a `{t:"sync", c0, s1}` reply. */
  onReply(c0: number, s1: number): void {
    const c1 = performance.now();
    const rtt = c1 - c0;
    if (rtt < 0 || rtt > 4000) return;
    const offset = s1 - (c0 + c1) / 2;
    if (!this.firstReplyAt) this.firstReplyAt = c1;

    this.samples.push({ offset, rtt });
    if (this.samples.length > WINDOW) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.bestOffset = best.offset;
    this.bestRtt = best.rtt;
    if (!this.haveOffset) {
      this.appliedOffset = best.offset;
      this.haveOffset = true;
      this.lastSlewAt = c1;
    }

    this.recentBest.push(best.offset);
    if (this.recentBest.length > 3) this.recentBest.shift();
    const spread = Math.max(...this.recentBest) - Math.min(...this.recentBest);
    const good =
      this.samples.length >= MIN_SAMPLES &&
      best.rtt <= MAX_READY_RTT_MS &&
      this.recentBest.length >= 3 &&
      spread <= STABLE_MS;
    if (good) {
      this.ready = true;
      this.degraded = false;
    } else if (!this.ready && this.samples.length >= 6 && c1 - this.firstReplyAt > FALLBACK_MS) {
      this.ready = true;
      this.degraded = true;
    }
  }

  /** Current server time in milliseconds. */
  serverNow(): number {
    const now = performance.now();
    const dt = this.lastSlewAt ? now - this.lastSlewAt : 0;
    this.lastSlewAt = now;
    const diff = this.bestOffset - this.appliedOffset;
    if (Math.abs(diff) <= SNAP_MS) this.appliedOffset = this.bestOffset;
    else this.appliedOffset += Math.sign(diff) * Math.min(Math.abs(diff), SLEW_PER_MS * Math.max(0, dt));
    return now + this.appliedOffset;
  }

  /** Forget everything, e.g. after the tab returns from the background. */
  reset(): void {
    this.samples = [];
    this.recentBest = [];
    this.firstReplyAt = 0;
    this.ready = false;
    this.degraded = false;
    this.bestRtt = Infinity;
  }
}

/** Pings quickly until ready, then every few seconds to follow drift. */
export function startClockSync(clock: ClockSync): () => void {
  let stopped = false;
  let timer = 0;
  const loop = () => {
    if (stopped) return;
    clock.ping();
    timer = window.setTimeout(loop, clock.ready ? 2000 : 150);
  };
  loop();
  const onVisible = () => {
    if (document.visibilityState !== "visible" || stopped) return;
    clock.reset();
    // Ping now rather than after the slow interval that was waiting, so the clock (and the
    // phone's light) is back within a second or two.
    clearTimeout(timer);
    loop();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
