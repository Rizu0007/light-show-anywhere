#!/usr/bin/env node
// Renders the project's demo video (src/demo/demo.ts) in headless Chrome, adds the spoken narration
// (the page's NARRATION) and saves it as MP4, plus a WebM copy for players without AAC (VS Code),
// and a square 1080 × 1080 MP4 for social feeds (…-square.mp4).
//
// Voice: Kokoro, an open neural voice that runs offline (../.demo-tools: a Python venv with
// kokoro-onnx and soundfile, and models/kokoro-v1.0.onnx + voices-v1.0.bin); without it, macOS `say`.
// VOICE picks the voice (Kokoro: am_puck (default), af_heart, af_bella, am_michael, bf_emma…; say: Samantha…);
// NO_VOICE=1 leaves the narration out. The music dips while the voice speaks.
//
// Needs lsa-server, `npm run dev`, the Tesla example show (../scripts/fetch-tesla-example.sh) and
// the app screenshots (scripts/capture-app.mjs), and ffmpeg.
//   node scripts/make-demo.mjs [output.mp4]      (the square one is saved next to it)

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserSession, until } from "./browser.mjs";

const APP = process.env.APP ?? "http://localhost:5173";
const root = fileURLToPath(new URL("../..", import.meta.url));
const example = `${root}shows/tesla/lightshow_example_1_elevator_music/lightshow_example_1_elevator_music`;
const shots = `${root}media/shots`;
const output = resolve(process.argv[2] ?? `${root}media/light-show-anywhere-demo.mp4`);
const tools = `${root}.demo-tools`;

if (!existsSync(`${shots}/host-loaded.png`)) console.log("no app screenshots: run scripts/capture-app.mjs first");

const square = output.replace(/\.mp4$/, "") + "-square.mp4";
let narration;
const chrome = await browserSession();
try {
  for (const [format, file] of [["wide", output], ["square", square]]) {
    const page = await chrome.openPage(
      `${APP}/demo.html?show=/@fs${example}/lightshow.fseq&song=/@fs${example}/lightshow.wav&shots=/@fs${shots}&format=${format}&t=0`,
    );
    await until(() => page.evaluate(`typeof window.__renderDemo === "function"`), "the demo page");
    narration = await page.evaluate(`window.__demoNarration`);
    const started = Date.now();
    const size = await page.evaluate(`window.__renderDemo()`);
    console.log(`${format}: rendered ${(size / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    const parts = [];
    const SLICE = 4 * 1024 * 1024;
    for (let from = 0; from < size; from += SLICE) {
      parts.push(Buffer.from(await page.evaluate(`window.__demoSlice(${from}, ${from + SLICE})`), "base64"));
    }
    mkdirSync(resolve(file, ".."), { recursive: true });
    writeFileSync(file, Buffer.concat(parts));
  }
} finally {
  await chrome.close();
}
if (!process.env.NO_VOICE) narrate([output, square], narration);
saveWebm(output);
console.log(`saved ${output} and ${square}`);

function run(cmd, args, input) {
  const result = spawnSync(cmd, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${cmd} failed: ${result.stderr || result.error}`);
  return result.stdout;
}
function duration(file) {
  return Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]));
}

/** Speaks every line into `dir`, faster where a line would run into the next. */
function speak(lines, dir) {
  const python = `${tools}/venv/bin/python`;
  if (existsSync(python) && existsSync(`${tools}/models/kokoro-v1.0.onnx`)) {
    const voice = process.env.VOICE ?? "am_puck";
    const speeds = lines.map(() => 1);
    const files = lines.map((_, i) => join(dir, `${i}.wav`));
    let todo = lines.map((_, i) => i);
    while (todo.length > 0) {
      const request = todo.map((i) => ({ text: lines[i][2], out: files[i], speed: speeds[i] }));
      const lengths = run(python, ["-I", fileURLToPath(new URL("tts.py", import.meta.url)), `${tools}/models`], JSON.stringify(request))
        .trim()
        .split("\n")
        .map(Number);
      todo = todo.filter((i, n) => {
        const fits = lengths[n] <= lines[i][1] || speeds[i] >= 1.3;
        if (fits) {
          console.log(`  ${lines[i][0].toFixed(1).padStart(5)} s  ${lengths[n].toFixed(1)}/${lines[i][1]} s  ×${speeds[i].toFixed(2)}  ${lines[i][2].slice(0, 50)}`);
        } else speeds[i] += 0.05;
        return !fits;
      });
    }
    return { files, voice: `Kokoro ${voice}` };
  }
  if (spawnSync("say", ["-v", "?"]).status !== 0) return null;
  const voice = process.env.VOICE ?? "Samantha";
  const files = lines.map(([, room, words], i) => {
    const file = join(dir, `${i}.aiff`);
    for (let rate = 175; ; rate += 10) {
      run("say", ["-v", voice, "-r", String(rate), "-o", file, words]);
      if (duration(file) <= room || rate >= 230) return file;
    }
  });
  return { files, voice: `say ${voice}` };
}

/** Mixes the narration over each video's music, which dips while the voice speaks. */
function narrate(videos, lines) {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
    console.log("no ffmpeg: video saved without narration");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "lsa-voice-"));
  try {
    const spoken = speak(lines, dir);
    if (!spoken) {
      console.log("no voice available: video saved without narration");
      return;
    }
    for (const video of videos) mix(video, lines, spoken.files, dir);
    console.log(`narrated by ${spoken.voice}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Mixes the spoken `files` (one per line of `lines`) into `video`. */
function mix(video, lines, files, dir) {
  const seconds = duration(video);
  const inputs = files.flatMap((file) => ["-i", file]);
  const delayed = files.map(
    (_, i) => `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(lines[i][0] * 1000)}:all=1[v${i}]`,
  );
  const voices = files.map((_, i) => `[v${i}]`).join("");
  // The voice is padded to the video's length: the ducking stops when either input ends. The
  // mix is brought to -16 LUFS, the usual loudness for online video.
  const filter = [
    ...delayed,
    `${voices}amix=inputs=${files.length}:normalize=0,volume=1.5,apad=whole_dur=${seconds},atrim=0:${seconds},asplit=2[voice][key]`,
    `[0:a][key]sidechaincompress=threshold=0.02:ratio=10:attack=30:release=500[music]`,
    `[music][voice]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[out]`,
  ].join(";");
  const mixed = join(dir, "mixed.mp4");
  run("ffmpeg", ["-v", "error", "-y", "-i", video, ...inputs, "-filter_complex", filter, "-map", "0:v", "-map", "[out]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", mixed]);
  copyFileSync(mixed, video);
}

/** A WebM copy (VP9 + Opus): players without AAC, such as VS Code's preview, play its sound. */
function saveWebm(video) {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return;
  const webm = video.replace(/\.mp4$/, ".webm");
  run("ffmpeg", ["-v", "error", "-y", "-i", video, "-c:v", "libvpx-vp9", "-b:v", "1500k", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-c:a", "libopus", "-b:a", "160k", webm]);
  console.log(`saved ${webm}`);
}
