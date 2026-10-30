/**
 * Speaker calibration tones and the detector that finds them in a microphone recording.
 *
 * The tone is a short rising sweep. Sweeps stand out from music and voices, and correlating a
 * recording with the known sweep (a matched filter) pins down its arrival to a fraction of a
 * millisecond even in a noisy room. Several tones are recorded and averaged before searching,
 * which cancels noise that does not repeat with them.
 *
 * Pure functions (no browser APIs), so scripts/chirp-test.mjs can test them in Node.
 */

/** Tone length. */
export const CHIRP_MS = 80;
const START_HZ = 2000;
const END_HZ = 6000;

/** Longest delay searched for (Bluetooth speakers reach ~300 ms; sound travels ~3 ms/m). It
 *  must stay below the gap between tones (lsa-server's CALIBRATION_GAP_MS), or a late tone
 *  would be taken for the next one. */
export const MAX_DELAY_MS = 600;
/** Searched before the scheduled time too, for clocks that are slightly off. */
export const EARLY_MS = 50;
/** Matched-filter peak over the typical level needed to trust a detection. */
const MIN_CLARITY = 8;
/** The first peak at least this fraction of the strongest is the direct sound; later ones may
 *  be louder echoes. */
const DIRECT_FRACTION = 0.5;

/** The calibration tone: a Hann-windowed linear sweep at `sampleRate`. */
export function chirp(sampleRate: number): Float32Array<ArrayBuffer> {
  const length = Math.round((CHIRP_MS / 1000) * sampleRate);
  const duration = length / sampleRate;
  const rate = (END_HZ - START_HZ) / duration;
  const tone = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
    tone[i] = window * Math.sin(2 * Math.PI * (START_HZ * t + (rate * t * t) / 2));
  }
  return tone;
}

export interface Detection {
  /** How late the tones arrived after their scheduled times. */
  delayMs: number;
  /** Peak over the typical matched-filter level; higher is more certain. */
  clarity: number;
}

/**
 * Finds how late the tones in `recording` arrived. `scheduled` holds, for each tone, the
 * (fractional) sample index in `recording` at which it should have been heard with no delay.
 * Returns `null` when the tones are not clearly there.
 */
export function findDelay(recording: Float32Array, sampleRate: number, scheduled: number[]): Detection | null {
  const tone = chirp(sampleRate);
  const early = Math.round((EARLY_MS / 1000) * sampleRate);
  const span = early + Math.round((MAX_DELAY_MS / 1000) * sampleRate) + tone.length;

  // Average the stretch around every tone, aligned on its scheduled time.
  const average = new Float64Array(span);
  let used = 0;
  // Each stretch starts at a whole sample; remember how far that is from the exact time.
  let rounding = 0;
  for (const at of scheduled) {
    const start = Math.round(at) - early;
    if (start < 0 || start + span > recording.length) continue;
    for (let i = 0; i < span; i++) average[i] += recording[start + i];
    rounding += Math.round(at) - at;
    used++;
  }
  if (used === 0) return null;

  const correlation = crossCorrelate(average, tone);
  const lags = span - tone.length + 1;
  const strength = new Float64Array(lags);
  for (let lag = 0; lag < lags; lag++) strength[lag] = Math.abs(correlation[lag]);

  let strongest = 0;
  for (let lag = 1; lag < lags; lag++) if (strength[lag] > strength[strongest]) strongest = lag;
  const typical = median(strength);
  const clarity = typical > 0 ? strength[strongest] / typical : 0;
  if (!(clarity >= MIN_CLARITY)) return null;

  // Earliest strong peak: the sound that came straight from the speaker. The correlation
  // ripples at the tone's pitch, so take the top of the whole peak, within a millisecond.
  let direct = strongest;
  const peakWidth = Math.round(sampleRate / 1000);
  for (let lag = 0; lag < strongest; lag++) {
    if (strength[lag] >= DIRECT_FRACTION * strength[strongest]) {
      direct = lag;
      for (let next = lag; next < Math.min(lags, lag + peakWidth); next++) {
        if (strength[next] > strength[direct]) direct = next;
      }
      break;
    }
  }
  const delaySamples = direct - early + rounding / used;
  return { delayMs: (delaySamples / sampleRate) * 1000, clarity };
}

/** `out[lag] = Σ signal[lag + i] · kernel[i]`, via FFT. */
function crossCorrelate(signal: Float64Array, kernel: Float32Array): Float64Array {
  let size = 1;
  while (size < signal.length + kernel.length) size *= 2;
  const aRe = new Float64Array(size);
  const aIm = new Float64Array(size);
  const bRe = new Float64Array(size);
  const bIm = new Float64Array(size);
  aRe.set(signal);
  for (let i = 0; i < kernel.length; i++) bRe[i] = kernel[i];
  fft(aRe, aIm, false);
  fft(bRe, bIm, false);
  // Multiply by the conjugate of the kernel's spectrum: correlation instead of convolution.
  for (let i = 0; i < size; i++) {
    const re = aRe[i] * bRe[i] + aIm[i] * bIm[i];
    const im = aIm[i] * bRe[i] - aRe[i] * bIm[i];
    aRe[i] = re;
    aIm[i] = im;
  }
  fft(aRe, aIm, true);
  return aRe.subarray(0, signal.length);
}

/** In-place iterative radix-2 FFT; `inverse` also divides by the size. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let length = 2; length <= n; length *= 2) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / length;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < length / 2; k++) {
        const a = start + k;
        const b = a + length / 2;
        const tRe = re[b] * wRe - im[b] * wIm;
        const tIm = re[b] * wIm + im[b] * wRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const next = wRe * stepRe - wIm * stepIm;
        wIm = wRe * stepIm + wIm * stepRe;
        wRe = next;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

function median(values: Float64Array): number {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(sorted.length / 2)];
}
