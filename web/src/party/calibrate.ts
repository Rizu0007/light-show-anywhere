/**
 * Speaker calibration: the host plays tones at shared-clock times; phones record them and measure
 * how late they arrive (audio output + speaker + distance + the phone's own mic delay).
 */

import { CHIRP_MS, MAX_DELAY_MS, chirp, findDelay } from "./chirp";

/** A calibration round, as announced by the server. */
export interface CalibrationRequest {
  /** Shared-clock time of the first tone. */
  at: number;
  tones: number;
  gapMs: number;
}

/** A just-started audio clock runs unevenly (up to 8 ms off); after 2 s it is within a block. */
const WARM_UP_S = 2;

/** `performance.now()` minus the audio clock (ms): the smallest difference seen, ± one block. */
async function audioOffset(ctx: AudioContext): Promise<number> {
  while (ctx.currentTime < WARM_UP_S) await new Promise((resolve) => setTimeout(resolve, 10));
  let best = Infinity;
  const until = performance.now() + 150;
  while (performance.now() < until) {
    best = Math.min(best, performance.now() - ctx.currentTime * 1000);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return best;
}

/** Host: plays the tones so each leaves the browser at its shared-clock time (to the speaker,
 *  or to `output` in tests). */
export async function playTones(
  ctx: AudioContext,
  serverNow: () => number,
  request: CalibrationRequest,
  output: AudioNode = ctx.destination,
): Promise<void> {
  await ctx.resume();
  const offset = await audioOffset(ctx);
  const tone = chirp(ctx.sampleRate);
  const buffer = ctx.createBuffer(1, tone.length, ctx.sampleRate);
  buffer.copyToChannel(tone, 0);
  const serverToPerf = serverNow() - performance.now();
  for (let k = 0; k < request.tones; k++) {
    const server = request.at + k * request.gapMs;
    const when = (server - serverToPerf - offset) / 1000;
    if (when < ctx.currentTime) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(output);
    source.start(when);
  }
}

/** Collects microphone samples on the audio thread with their audio-clock frame numbers. */
const RECORDER = `
class Recorder extends AudioWorkletProcessor {
  process(inputs) {
    const samples = inputs[0] && inputs[0][0];
    if (samples) this.port.postMessage({ frame: currentFrame, samples: samples.slice() });
    return true;
  }
}
registerProcessor("lsa-recorder", Recorder);
`;

const loadedRecorders = new WeakSet<AudioContext>();

/** Phone: how late the tones arrived (ms), or `null` if not heard or no microphone. */
export async function listenForTones(
  ctx: AudioContext,
  serverNow: () => number,
  request: CalibrationRequest,
): Promise<number | null> {
  let stream: MediaStream | null = null;
  try {
    await ctx.resume();
    stream = await navigator.mediaDevices.getUserMedia({
      // Raw sound: echo cancellation and noise suppression would remove the tones.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (!loadedRecorders.has(ctx)) {
      const url = URL.createObjectURL(new Blob([RECORDER], { type: "text/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      loadedRecorders.add(ctx);
    }

    const input = ctx.createMediaStreamSource(stream);
    const recorder = new AudioWorkletNode(ctx, "lsa-recorder");
    // The recorder only runs while connected to the output; keep it silent.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    input.connect(recorder).connect(mute).connect(ctx.destination);

    const blocks: { frame: number; samples: Float32Array }[] = [];
    recorder.port.onmessage = (event: MessageEvent<{ frame: number; samples: Float32Array }>) => {
      blocks.push(event.data);
    };
    const offset = await audioOffset(ctx);
    const serverToPerf = serverNow() - performance.now();

    const end = request.at + (request.tones - 1) * request.gapMs + MAX_DELAY_MS + CHIRP_MS + 200;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, end - serverNow())));
    input.disconnect();
    recorder.disconnect();
    recorder.port.onmessage = null;
    if (blocks.length === 0) return null;

    const first = blocks[0].frame;
    const length = blocks[blocks.length - 1].frame + blocks[blocks.length - 1].samples.length - first;
    const recording = new Float32Array(length);
    for (const block of blocks) recording.set(block.samples, block.frame - first);

    // Where each tone would be in the recording if it arrived with no delay.
    const scheduled = Array.from({ length: request.tones }, (_, k) => {
      const perf = request.at + k * request.gapMs - serverToPerf;
      return ((perf - offset) / 1000) * ctx.sampleRate - first;
    });
    return findDelay(recording, ctx.sampleRate, scheduled)?.delayMs ?? null;
  } catch {
    return null;
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}
