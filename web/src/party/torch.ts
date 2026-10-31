/**
 * The phone's flashlight, driven through the camera: Chrome on Android, and Safari since iOS 17
 * (WebKit bug 262131). Phones with several back cameras often give the page one without a flash,
 * and some only report the flash once the camera is running, so every back camera is tried, each
 * after it starts.
 */

export interface Torch {
  /** Turns the flash on or off. */
  set(on: boolean): void;
  stop(): void;
}

/** The flashlight, or why it cannot be used (shown on the phone and to the host). */
export type TorchResult = { torch: Torch; problem: null } | { torch: null; problem: string };

/** How long a camera has to report a flash once it is running. */
const SETTLE_MS = 1500;

const failed = (problem: string): TorchResult => ({ torch: null, problem });

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function hasTorch(track: MediaStreamTrack): boolean {
  return !!(track.getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean }).torch;
}

interface Camera {
  track: MediaStreamTrack;
  video: HTMLVideoElement;
  /** The camera reports a flash. */
  torch: boolean;
}

/** Plays the camera into a hidden video (some phones only run it, and light the flash, while its
 *  frames are used) and waits a little for it to report a flash. */
async function start(stream: MediaStream): Promise<Camera | null> {
  const track = stream.getVideoTracks()[0];
  if (!track) return null;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  const until = performance.now() + SETTLE_MS;
  while (!hasTorch(track) && performance.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
  return { track, video, torch: hasTorch(track) };
}

function release({ track, video }: Camera) {
  track.stop();
  video.srcObject = null;
}

/** Asks for the camera (call from a tap) and finds a back camera with a flash. */
export async function openTorch(): Promise<TorchResult> {
  if (!window.isSecureContext) return failed("the flashlight needs the https:// address");
  if (!navigator.mediaDevices?.getUserMedia) return failed("this browser can't use the camera");

  let first: MediaStream;
  try {
    first = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
  } catch (error) {
    const name = (error as DOMException).name;
    if (name === "NotAllowedError") return failed("camera permission was denied");
    if (name === "NotReadableError") return failed("another app is using the camera");
    return failed("no camera found");
  }

  const firstId = first.getVideoTracks()[0]?.getSettings().deviceId;
  const firstCamera = await start(first);
  let found = firstCamera?.torch || (firstCamera && isIos()) ? firstCamera : null;
  // iPhones can light the flash without reporting it (getSupportedConstraints says no on some
  // iOS versions), so an iPhone keeps the back camera it was given and tries anyway. Other phones
  // try their other cameras, back ones first (names are known now that permission is given), one
  // at a time: many cannot open two at once.
  if (!found) {
    if (firstCamera) release(firstCamera);
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "videoinput" && d.deviceId !== firstId && !/front|user|facing front/i.test(d.label),
    );
    devices.sort((a, b) => Number(/back|rear|environment/i.test(b.label)) - Number(/back|rear|environment/i.test(a.label)));
    for (const device of devices) {
      const stream = await navigator.mediaDevices
        .getUserMedia({ video: { deviceId: { exact: device.deviceId } } })
        .catch(() => null);
      const camera = stream && (await start(stream));
      if (camera?.torch) {
        found = camera;
        break;
      }
      if (camera) release(camera);
    }
  }
  if (!found) {
    return failed(isIos() ? "needs iOS 17 or later" : "this phone's browser can't control the flash");
  }

  const { track, video } = found;
  let wanted: boolean | null = null;
  return {
    problem: null,
    torch: {
      set(on) {
        if (on === wanted) return;
        wanted = on;
        void track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] }).catch(() => undefined);
      },
      stop() {
        release({ track, video, torch: true });
      },
    },
  };
}
