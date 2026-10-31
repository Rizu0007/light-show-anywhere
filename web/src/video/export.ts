/** Exports the preview and the song as a video file, frame by frame (faster than playing it and
 *  frame-exact), with Mediabunny (MPL-2.0), loaded only when exporting. */

import type { Show, Vehicle } from "../engine";
import type { Spot } from "../party/layouts";
import { HEIGHT, WIDTH, drawFrame } from "./render";

export const FPS = 30;

export interface ExportOptions {
  /** One Show per car, car 1 first. */
  fleet: Show[];
  /** Car drawn when not filming the crowd (0-based). */
  car: number;
  bars: boolean;
  /** Which closures the car has (Model X falcon doors, Cybertruck frunk). */
  vehicle: Vehicle;
  /** Film this crowd layout instead of the car. */
  crowd: Spot[] | null;
  title: string;
  song: Blob | null;
  /** Export only the first `limitMs` (tests). */
  limitMs?: number;
  onProgress: (fraction: number) => void;
  signal: AbortSignal;
}

export interface ExportedVideo {
  blob: Blob;
  /** File extension with the dot, e.g. ".mp4". */
  extension: string;
}

/** The song, decoded and cut to `durationMs`. */
async function songBuffer(song: Blob, durationMs: number): Promise<AudioBuffer> {
  const decoder = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: 48000 });
  const full = await decoder.decodeAudioData(await song.arrayBuffer());
  const length = Math.min(full.length, Math.ceil((durationMs / 1000) * full.sampleRate));
  const cut = new AudioBuffer({ length, numberOfChannels: full.numberOfChannels, sampleRate: full.sampleRate });
  for (let c = 0; c < full.numberOfChannels; c++) cut.copyToChannel(full.getChannelData(c).subarray(0, length), c);
  return cut;
}

export async function exportVideo(options: ExportOptions): Promise<ExportedVideo> {
  const mb = await import("mediabunny");
  const videoCodec = await mb.getFirstEncodableVideoCodec(["avc", "vp9", "vp8"], { width: WIDTH, height: HEIGHT });
  if (!videoCodec) throw new Error("this browser cannot encode video");
  // H.264 goes in MP4, which plays everywhere; otherwise WebM.
  const mp4 = videoCodec === "avc";
  const format = mp4 ? new mb.Mp4OutputFormat({ fastStart: "in-memory" }) : new mb.WebMOutputFormat();
  const output = new mb.Output({ format, target: new mb.BufferTarget() });

  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2D canvas");
  const video = new mb.CanvasSource(canvas, { codec: videoCodec, quality: mb.QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: FPS });

  const durationMs = Math.min(
    Math.max(...options.fleet.map((s) => s.durationMs)),
    options.limitMs ?? Infinity,
  );
  let audio: { source: InstanceType<typeof mb.AudioBufferSource>; buffer: AudioBuffer } | null = null;
  if (options.song) {
    const buffer = await songBuffer(options.song, durationMs);
    const audioCodec = await mb.getFirstEncodableAudioCodec(mp4 ? ["aac", "opus"] : ["opus", "vorbis"], {
      numberOfChannels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
    });
    if (audioCodec) {
      const source = new mb.AudioBufferSource({ codec: audioCodec, quality: mb.QUALITY_HIGH });
      output.addAudioTrack(source);
      audio = { source, buffer };
    }
  }

  await output.start();
  try {
    if (audio) await audio.source.add(audio.buffer);
    const frames = Math.ceil((durationMs / 1000) * FPS);
    for (let i = 0; i < frames; i++) {
      if (options.signal.aborted) throw new DOMException("export cancelled", "AbortError");
      const timeMs = (i * 1000) / FPS;
      drawFrame(ctx, {
        levelsByCar: options.fleet.map((s) => s.levelsAt(timeMs)),
        car: options.car,
        bars: options.bars,
        vehicle: options.vehicle,
        crowd: options.crowd,
        title: options.title,
        timeMs,
        durationMs,
      });
      await video.add(i / FPS, 1 / FPS);
      if (i % FPS === 0) options.onProgress(i / frames);
    }
    await output.finalize();
  } catch (error) {
    await output.cancel();
    throw error;
  }
  const buffer = (output.target as InstanceType<typeof mb.BufferTarget>).buffer;
  if (!buffer) throw new Error("the video came out empty");
  options.onProgress(1);
  return { blob: new Blob([buffer], { type: format.mimeType }), extension: format.fileExtension };
}

/** Development: what a video file holds, for scripts/video-e2e.mjs. */
export async function inspectVideo(blob: Blob) {
  const mb = await import("mediabunny");
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  return {
    mimeType: await input.getMimeType(),
    durationS: await input.computeDuration(),
    width: video?.displayWidth ?? 0,
    height: video?.displayHeight ?? 0,
    videoCodec: video?.codec ?? null,
    audioCodec: audio?.codec ?? null,
    frames: video ? (await video.computePacketStats()).packetCount : 0,
    // Lit pixels in the picture (below the title) at each second, to see the show change.
    lit: video ? await litPixels(new mb.CanvasSink(video), await input.computeDuration()) : [],
  };
}

async function litPixels(sink: { getCanvas(t: number): Promise<{ canvas: HTMLCanvasElement | OffscreenCanvas } | null> }, durationS: number) {
  const counts: number[] = [];
  for (let t = 0.5; t < durationS; t += 1) {
    const frame = await sink.getCanvas(t);
    const ctx = frame?.canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) continue;
    const { data } = ctx.getImageData(0, 70, frame!.canvas.width, frame!.canvas.height - 130);
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 200 || data[i + 1] > 200) lit++;
    counts.push(lit);
  }
  return counts;
}
