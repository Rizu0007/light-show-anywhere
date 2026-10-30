import { useEffect, type RefObject } from "react";
import type { HostParty } from "./useHost";

const CHECK_EVERY_MS = 500;
const MAX_DRIFT_MS = 80;

/** Plays the host's song on the shared clock, `speakerDelayMs` early to make up for the speaker. */
export function useSyncedAudio(
  audio: RefObject<HTMLAudioElement | null>,
  party: HostParty,
  speakerDelayMs: number,
  audioUrl: string | null,
): void {
  const { active, playback, serverNow } = party;

  useEffect(() => {
    const el = audio.current;
    if (!active || !el || !audioUrl) return;
    const { playing, t0, positionMs } = playback;
    if (!playing || t0 === null) {
      el.pause();
      el.currentTime = positionMs / 1000;
      return;
    }

    let startTimer = 0;
    let checkTimer = 0;
    const songPosition = (server: number) => Math.max(positionMs, server - t0 + speakerDelayMs);

    const check = () => {
      const server = serverNow();
      if (server === null || el.paused) return;
      const expected = songPosition(server);
      if (Math.abs(el.currentTime * 1000 - expected) > MAX_DRIFT_MS) el.currentTime = expected / 1000;
    };
    const begin = () => {
      const server = serverNow();
      if (server === null) return;
      el.currentTime = songPosition(server) / 1000;
      void el.play();
      checkTimer = window.setInterval(check, CHECK_EVERY_MS);
    };

    const server = serverNow();
    // Server time at which the song should be at `positionMs`.
    const wait = server === null ? 0 : t0 + positionMs - speakerDelayMs - server;
    if (wait > 0) startTimer = window.setTimeout(begin, wait);
    else begin();

    return () => {
      clearTimeout(startTimer);
      clearInterval(checkTimer);
    };
  }, [audio, active, playback, serverNow, speakerDelayMs, audioUrl]);
}
