/**
 * Keeps the screen awake where supported (needs HTTPS). The browser drops the lock whenever the
 * page is hidden (screen locked, another app), so it is taken again each time the page comes
 * back. `onChange` hears whether the screen is kept awake (`null`: this browser cannot).
 */
export function keepAwake(onChange: (awake: boolean | null) => void): () => void {
  if (!("wakeLock" in navigator)) {
    onChange(null);
    return () => undefined;
  }
  let lock: WakeLockSentinel | null = null;
  let requesting = false;
  let stopped = false;
  const request = async () => {
    if (stopped || lock || requesting || document.visibilityState !== "visible") return;
    requesting = true;
    try {
      const taken = await navigator.wakeLock.request("screen");
      if (stopped) {
        void taken.release();
        return;
      }
      lock = taken;
      onChange(true);
      taken.addEventListener("release", () => {
        lock = null;
        onChange(false);
      });
    } catch {
      onChange(false);
    } finally {
      requesting = false;
    }
  };
  const onVisible = () => void request();
  document.addEventListener("visibilitychange", onVisible);
  void request();
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisible);
    void lock?.release();
  };
}
