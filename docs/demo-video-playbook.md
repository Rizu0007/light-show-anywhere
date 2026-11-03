# Demo Video Playbook

How to make a narrated, animated demo video for a software project, entirely from code: real
screenshots of the app, animated explainer scenes, an offline human-sounding voice, music, and
subtitles, rendered to MP4. Written for Claude Code to follow in any project; it was first used for
Light Show Anywhere (a 68 s video in 16:9 and square, rendered in about 2 minutes).

**Why code instead of a video editor:** every frame is exact and reproducible, the video is made
from the app's *real* rendering code and data (it cannot drift from what the product does), and
changing a sentence or a scene is an edit plus one command.

---

## 0. Ask the user first (one round, then proceed)

Use `AskUserQuestion` once, with recommendations:

1. **Voice:** Kokoro offline neural voice (recommended, ~350 MB download), an Apple Premium voice the
   user downloads in System Settings, or the user's own recording.
2. **Scenes that need "real life" footage** (people, venues, devices): AI video generators (Sora,
   Runway, Veo) need accounts Claude cannot sign in to. Offer an animated scene drawn in code
   (recommended) or prompts the user runs themselves.
3. **Walkthrough:** start with a real "how to use it" walkthrough from app screenshots? (Usually yes.)
4. **Music:** the user's own track, a royalty-free track, or a soft generated pad (default).

State file names, sources and sizes before downloading anything.

## 1. Plan the story (before writing code)

Write the scene list with times, what is shown, and one narration line per scene. A structure that
works:

| Time | Scene | Purpose |
|---|---|---|
| 0–4 s | Title + one-line promise | What it is |
| 4–8 s | The idea / the problem | Why it exists |
| 8–28 s | **How to use it** (3–5 steps, real screenshots) | Show the product, not just talk |
| … | How it works (2–4 scenes) | The clever parts, one idea each |
| … | **Hero scene** (the product in real life) | The emotional "wow" moment |
| … | Features grid | Everything else, briefly |
| last 8 s | Tech stack + title + tagline | Close |

Rules of thumb:

- **One idea per scene, 4–12 s each.** Narration ≈ 2.6 words/second; leave ~0.5 s of air.
- Write narration **like a person explaining to a friend**: short sentences, commas for breathing,
  "Here's how it works." Read it aloud mentally; cut every clause that doesn't help.
- If the app has data that animates (audio, charts, a simulation), **find the busiest stretches of
  that data and put the visual scenes on them**; put talky scenes on the quiet stretches. Measure it
  (see §8), don't guess.
- Put any claim with a number in it only if it was measured, and say where it came from.

## 2. Architecture

```
demo.html + src/demo/demo.ts      one page: drawDemo(ctx, t) draws any frame at time t (seconds)
   ├─ ?t=12.5                     shows one still frame (for checking with screenshots)
   ├─ no ?t                       plays the animation live
   └─ window.__renderDemo()       renders every frame → MP4 in the browser (Mediabunny)
scripts/capture-app.mjs           headless Chrome drives the real app, saves PNG screenshots
scripts/make-demo.mjs             headless Chrome renders the page → MP4, then:
   ├─ tts.py (Kokoro)             speaks NARRATION lines to WAV, sped up only if a line won't fit
   ├─ ffmpeg                      mixes voice over music (music ducks under voice), −16 LUFS
   └─ ffmpeg                      WebM copy (VP9 + Opus) for players without AAC
media/                            outputs (git-ignored); .demo-tools/ venv + models (git-ignored)
```

Everything is deterministic: same inputs → same video.

### Key decisions (learned the hard way)

- **Render frame by frame, not by screen recording.** `drawDemo(ctx, i / FPS)` for every frame, then
  encode. Frame-exact, faster than real time, no dropped frames.
- **Keep narration in the page** (`export const NARRATION: [start, room, text][]`). The page draws it
  as subtitles; the render script reads it (`window.__demoNarration`) and speaks it. One source of
  truth.
- **Reuse the app's own drawing code** where possible (the real preview/renderer drawn into an
  `OffscreenCanvas`, then `drawImage`d into the scene). The demo then shows the real thing.
- **Seeded random** (`random(seed)`), never `Math.random()`, so every render is identical.

## 3. The page (`demo.html` + `src/demo/demo.ts`)

Vite serves any `.html` at the web root in dev, so a second page needs no config. Skeleton:

```ts
const W = 1280, H = 720, FPS = 30;
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Scene { start: number; end: number; step?: string; heading?: string;
  draw: (ctx: Ctx, local: number, t: number) => void }   // local = seconds since scene start

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const ease = (x: number) => { const v = clamp(x); return v < 0.5 ? 4 * v ** 3 : 1 - (-2 * v + 2) ** 3 / 2; };
const ramp = (t: number, from: number, dur = 0.6) => ease((t - from) / dur);   // 0 → 1
function random(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

export const NARRATION: [number, number, string][] = [
  [0.5, 3.4, "This is <Product>, where <one-line promise>."],
  // [start seconds, room until the next line, words]
];

const scenes: Scene[] = [ /* … */ ];
scenes.sort((a, b) => a.start - b.start);
export const DURATION = scenes[scenes.length - 1].end;

export function drawDemo(ctx: Ctx, t: number) {
  ctx.fillStyle = "#05070a"; ctx.fillRect(0, 0, W, H);
  const scene = scenes.find((s) => t >= s.start && t < s.end) ?? scenes[scenes.length - 1];
  const local = t - scene.start;
  const fade = Math.min(clamp(local / 0.45), clamp((scene.end - t) / 0.45)); // cross-fade
  ctx.save(); ctx.globalAlpha = fade;
  if (scene.step) { /* small accent label at (70,58), heading at (70,98) */ }
  scene.draw(ctx, local, t);
  ctx.restore();
  const line = NARRATION.find(([at, room]) => t >= at && t < at + room);
  if (line) { /* rounded dark box at H-62, centred text: the subtitle */ }
  // thin progress bar along the bottom edge
}
```

Useful drawing helpers to write once: `text()` (font, align, alpha), `panel()` (rounded card),
`chip()` (pill label), `arrow()`, `phone()`/`device()` frames, `browserWindow(ctx, image, x, y, w, crop)`
(macOS-style window with traffic lights and a URL pill, showing a cropped screenshot and **returning
a mapper from screenshot pixels to screen pixels** so highlights and cursors land on real UI), `pointer()`
(mouse cursor), `ripple()` (click/tap ring).

### Scene techniques that look good

- **Walkthrough:** real screenshots inside a browser frame; animate the **crop** (`lerpCrop(full, target, ease(t))`)
  for a slow zoom into the important part; a cursor that eases to a button, a ripple on "click", then
  cross-fade to the next screenshot. Pulse a highlight ring around the key element (QR code, button).
  Reveal lists row by row by covering un-revealed rows with a background-coloured rectangle.
- **Files dropping in:** chips with file icons flying from the side into the window, ripple, cross-fade
  to the "loaded" screenshot.
- **Before/after graph:** two lanes drawing progressively (e.g. raw signal vs processed).
- **Pipeline:** boxes appearing one by one with arrows and a travelling dot.
- **Hero "real life" scene in 2.5D:** a pinhole camera projection gives convincing depth with plain
  canvas, no 3D library:

  ```ts
  interface Camera { x: number; h: number; z: number; pitch: number; f: number }
  function project(cam: Camera, X: number, Y: number, Z: number) {   // metres: x across, y up, z away
    const dx = X - cam.x, dy = Y - cam.h, dz = Z - cam.z;
    const c = Math.cos(cam.pitch), s = Math.sin(cam.pitch);
    const yc = dy * c + dz * s, zc = dz * c - dy * s;
    if (zc < 0.5) return null;
    return { x: W / 2 + (cam.f * dx) / zc, y: H / 2 - (cam.f * yc) / zc, s: cam.f / zc }; // s = px per metre
  }
  ```

  Draw far-to-near (sort by `z`). People = project feet and head, draw a tapered body between them
  (foreshortening comes free). Lights = `globalCompositeOperation = "lighter"` + radial gradients for
  glow, a gradient triangle for a beam, ground pools as projected ellipses. Sky gradient, stars,
  distant skyline, vignette. Animate the camera (`h`, `z`, `pitch`) with `ease()` for a dolly or a
  drone rise to top-down. **Mark the intended shape on the ground** (e.g. a taped outline) so the
  pattern reads from above.
- **Keep text off the subtitle band** (bottom ~70 px) and inside 70 px margins.

## 4. Real app screenshots (`scripts/capture-app.mjs`)

Drive the real app in **headless Chrome over the DevTools protocol** (no Puppeteer needed):

```js
import { spawn } from "node:child_process";
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${tmpProfile}`, "--no-first-run",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows", "about:blank"]);
// GET http://127.0.0.1:9333/json/version → webSocketDebuggerUrl; then per page:
//   Target.createTarget {url, newWindow:true} → Target.attachToTarget {flatten:true}
//   Runtime.evaluate {expression, returnByValue:true, awaitPromise:true}
//   Emulation.setDeviceMetricsOverride {width, height, deviceScaleFactor:1, mobile:false}
//   Page.captureScreenshot {format:"png"}  → base64
```

- Desktop shots at **1280 × 800**, phone shots at **390 × 844**.
- Wait for real conditions (`until(() => evaluate("…includes('Ready')"))`), not fixed sleeps.
- Click with `[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Start").click()`.
- Set React-controlled inputs with the native setter + an `input` event.
- **Hide dev-only noise** before shooting (e.g. a "you're on localhost" warning) and say so in the
  script comment: show what a real user sees.
- Multiple simulated users (phones) = more pages in the same Chrome.
- Re-run the capture whenever the UI changes; it's one command.

## 5. Rendering to MP4 in the browser (Mediabunny)

```ts
const mb = await import("mediabunny");
const codec = await mb.getFirstEncodableVideoCodec(["avc", "vp9"], { width: W, height: H });
const mp4 = codec === "avc";
const output = new mb.Output({
  format: mp4 ? new mb.Mp4OutputFormat({ fastStart: "in-memory" }) : new mb.WebMOutputFormat(),
  target: new mb.BufferTarget(),
});
const canvas = new OffscreenCanvas(W, H); const ctx = canvas.getContext("2d")!;
const video = new mb.CanvasSource(canvas, { codec, quality: mb.QUALITY_HIGH, keyFrameInterval: 2 });
output.addVideoTrack(video, { frameRate: FPS });
const audio = await soundtrack();            // AudioBuffer from an OfflineAudioContext (music bed)
const audioSource = new mb.AudioBufferSource({ codec: mp4 ? "aac" : "opus", quality: mb.QUALITY_HIGH });
output.addAudioTrack(audioSource);
await output.start();
await audioSource.add(audio);
for (let i = 0; i < Math.round(DURATION * FPS); i++) { drawDemo(ctx, i / FPS); await video.add(i / FPS, 1 / FPS); }
await output.finalize();
const bytes = new Uint8Array(output.target.buffer!);
```

- **Music bed** without a licence problem: synthesise a soft chord pad in an `OfflineAudioContext`
  (sine + triangle oscillators, slow attack/release, low-pass ~1.4 kHz, chord change every 4 s), and
  mix the product's own audio in where relevant. Fade in/out with `linearRampToValueAtTime`.
- Getting the bytes to Node: CDP `returnByValue` with a base64 string in **4 MB slices**
  (`window.__demoSlice(from, to)`); one giant string can exceed limits.
- Expose `window.__renderDemo()` and also a **"Render MP4" button** on the page for manual use.

## 6. The voice (Kokoro, offline)

Setup (state the sizes to the user first):

```bash
mkdir -p .demo-tools/models && cd .demo-tools
uv venv venv --python 3.12 && VIRTUAL_ENV=$PWD/venv uv pip install kokoro-onnx soundfile
cd models
curl -sSfLO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx   # ~326 MB
curl -sSfLO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin    # ~28 MB
```

`scripts/tts.py` (JSON lines on stdin → WAV files; prints each length):

```python
import json, os, sys
import soundfile as sf
from kokoro_onnx import Kokoro
models = sys.argv[1]
kokoro = Kokoro(os.path.join(models, "kokoro-v1.0.onnx"), os.path.join(models, "voices-v1.0.bin"))
voice = os.environ.get("VOICE", "af_heart")
for line in json.load(sys.stdin):
    samples, rate = kokoro.create(line["text"], voice=voice, speed=line["speed"], lang="en-us")
    sf.write(line["out"], samples, rate)
    print(f"{len(samples) / rate:.2f}", flush=True)
```

- Voices: `af_heart` (warm US female, best), `af_bella`, `am_michael` (US male), `bf_emma` (UK female).
- **Fit loop:** speak all lines at speed 1.0, measure, re-speak only lines longer than their `room`
  at +0.05 speed (cap ~1.3). If a line needs > 1.1, **shorten the text** instead; fast speech sounds robotic.
- Run Python with `-I` (isolated) from the venv.
- Fallback when Kokoro isn't installed: macOS `say -v Samantha -r 175 -o line.aiff "…"` (robotic; avoid
  for the final video).

## 7. Mixing (ffmpeg) — the exact filter that works

```
[1:a]aresample=48000,aformat=channel_layouts=stereo,adelay=<ms>:all=1[v0];   (one per line)
[v0][v1]…amix=inputs=N:normalize=0,volume=1.5,apad=whole_dur=<video s>,atrim=0:<video s>,asplit=2[voice][key];
[0:a][key]sidechaincompress=threshold=0.02:ratio=10:attack=30:release=500[music];
[music][voice]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[out]
```

`ffmpeg -i video.mp4 -i 0.wav … -filter_complex "<above>" -map 0:v -map "[out]" -c:v copy -c:a aac -b:a 192k -movflags +faststart out.mp4`

Then a WebM copy: `-c:v libvpx-vp9 -b:v 1500k -deadline realtime -cpu-used 8 -row-mt 1 -c:a libopus -b:a 160k`.

## 8. Checking the result (do all of these)

1. **Preview stills in a browser** (`demo.html?t=55.4`, or import the module and call `drawDemo`) and
   look at each scene before the full render. Watch for: text under the subtitle band, elements off
   screen, scenes that are dark because the data is quiet at that moment.
2. **Measure the data** to place scenes: e.g. per second, how many lights/values are active; put hero
   scenes on the busiest seconds.
3. **Contact sheet of the final file:** `ffmpeg -i out.mp4 -vf "select='eq(n\,300)+eq(n\,900)…',scale=640:-1,tile=2x4" -frames:v 1 sheet.png`, then read the image.
4. **Audio:** `ffprobe` (streams, durations: audio must be as long as video); per-section loudness
   with `-af volumedetect`; overall with `-af ebur128` (target ≈ −16 LUFS).
5. Open it in **QuickTime** (`open -a "QuickTime Player" out.mp4`), not an editor preview.

## 9. Pitfalls we hit (avoid them)

| Symptom | Cause | Fix |
|---|---|---|
| "No sound" | VS Code's media preview can't decode AAC | Play in QuickTime; also ship a WebM (Opus) copy |
| Sound stops ~2 s before the end | `sidechaincompress` ends when the shorter (voice) input ends | Pad the **voice** to the video length before `asplit` |
| ffmpeg hangs forever | `apad` (infinite) + `-shortest` in a filter graph | `apad=whole_dur=<s>,atrim=0:<s>`, no `-shortest` |
| Voice much quieter than before | Neural TTS output level is low | `loudnorm=I=-16` on the final mix |
| A preview still shows the wrong scene | The page's own `?t=` draw ran after yours (images still loading) | Navigate with the `?t=` you want, or wait for load |
| `MODULE_NOT_FOUND` in a shell loop | zsh does not word-split `$var` | Call each command separately, or use arrays |
| Simulated users show "not synced / can't stay awake" | Chrome throttles background tabs | Headless flags in §4; note it isn't a real-device problem |
| A scene looks empty | The real data is quiet at that moment | Measure activity (§8.2) and move the scene |
| Pattern doesn't read from above | Only lit points, no context | Draw the outline/shape on the ground |
| Robotic narration | Standard OS voices | Kokoro; shorter, conversational sentences |
| Writing a file failed silently and the old script ran | Edit tool refused (file changed) | Check tool results before running long jobs |

## 10. Making it even better next time

- **Real motion in the walkthrough:** record the app with CDP `Page.startScreencast` (JPEG frames +
  timestamps) instead of stills, and place those frames into the browser frame.
- **Vertical cut for social media** (1080 × 1920, 9:16): same scenes, a second layout per scene;
  render both from one command.
- **Subtitle file** (`.srt`) from `NARRATION`, for YouTube and accessibility.
- **Chapters:** write MP4 chapter metadata from the scene list.
- **Thumbnail:** export the hero frame as a PNG with the title.
- **Two voices** (narrator + "user" lines) using two Kokoro voices.
- **Music:** a licensed or royalty-free track with beats aligned to scene cuts.
- **Real AI footage** for one or two hero shots, if the user generates them (give them exact prompts,
  durations and aspect ratio), cut into the timeline with `drawImage` from a `<video>` element.
- **Captions with word timing** (karaoke-style highlight) using per-word lengths.

## 11. Checklist for Claude

- [ ] Ask the questions in §0 once; recommend defaults.
- [ ] Write the scene + narration plan (§1) and show it briefly.
- [ ] Capture real screenshots (§4); hide dev-only noise.
- [ ] Build `demo.html` + `demo.ts` (§3); preview stills of every scene.
- [ ] Measure the data; put hero scenes on busy stretches.
- [ ] Install the voice (§6), with sizes stated; fit-loop the narration.
- [ ] Render + mix (§5, §7); WebM copy.
- [ ] Verify (§8): contact sheet, audio duration, loudness, QuickTime.
- [ ] Git-ignore `media/` and `.demo-tools/`; commit the demo code only when asked.
- [ ] Tell the user: file paths, what each scene shows, what is animated vs real, any numbers' sources,
      the music's licence, and the one command to re-render.
