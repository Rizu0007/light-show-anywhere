#!/usr/bin/env node
// End-to-end party test: a scripted host plus real headless-Chrome phones.
//
// Needs `cargo run -p lsa-server` and `npm run dev` running. Usage:
//   node scripts/party-e2e.mjs <show.fseq> [channel] [seconds]
//
// The host bot creates a room, uploads the show, pins every phone to the same light and plays.
// Each phone records when its light crosses half brightness on the shared clock; the script
// compares those moments with the frame timing of the track the phone received (the show after
// the safety governor) and with each other.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [showPath, channelArg = "21", secondsArg = "10"] = process.argv.slice(2);
if (!showPath) {
  console.error("usage: node scripts/party-e2e.mjs <show.fseq> [channel] [seconds]");
  process.exit(2);
}
const CHANNEL = Number(channelArg);
const LISTEN_MS = Number(secondsArg) * 1000;
const PHONES = 2;
const APP = "http://localhost:5173";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9333;
const MAX_ERROR_MS = 40; // one 20 ms frame plus one 60 Hz screen refresh, with margin
const MAX_PHONE_GAP_MS = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ------------------------------------------------------------------ expected timing from the file

const bytes = new Uint8Array(readFileSync(showPath));
const view = new DataView(bytes.buffer);
const channelCount = view.getUint32(10, true);
const frameCount = view.getUint32(14, true);
const stepMs = bytes[18];

// ------------------------------------------------------------------ host bot

function hostBot() {
  const ws = new WebSocket(`${APP.replace("http", "ws")}/ws`);
  ws.binaryType = "arraybuffer";
  const inbox = [];
  ws.onmessage = (e) => typeof e.data === "string" && inbox.push(JSON.parse(e.data));
  const take = (t, where = () => true) => until(() => {
    const i = inbox.findIndex((m) => m.t === t && where(m));
    return i >= 0 ? inbox.splice(i, 1)[0] : null;
  }, `host message "${t}"`);
  const send = (m) => ws.send(JSON.stringify(m));
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("cannot reach the party server through the dev server (/ws)"));
  });
  return { ws, inbox, take, send, opened };
}

// ------------------------------------------------------------------ minimal Chrome DevTools client

async function chromeSession() {
  const profile = mkdtempSync(join(tmpdir(), "lsa-e2e-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "about:blank",
  ], { stdio: "ignore" });
  const version = await until(
    () => fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.json()).catch(() => null),
    "Chrome to start",
  );
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return {
    async openPage(url) {
      const { targetId } = await call("Target.createTarget", { url, newWindow: true });
      const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
      const evaluate = async (expression) =>
        (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
      return { evaluate };
    },
    async close() {
      ws.close();
      const exited = new Promise((r) => chrome.once("exit", r));
      chrome.kill();
      await Promise.race([exited, sleep(3000)]);
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Leftover temp profile is harmless.
      }
    },
  };
}

// ------------------------------------------------------------------ test

const host = hostBot();
const chrome = await chromeSession();
try {
  await host.opened;
  host.send({ t: "create" });
  const { room } = await host.take("created");
  host.send({ t: "load", vehicle: "model-3y", name: "e2e" });
  host.ws.send(bytes);
  await host.take("show");
  console.log(`room ${room}: show loaded (${frameCount} frames × ${channelCount} channels)`);

  const phones = [];
  for (let i = 0; i < PHONES; i++) {
    phones.push(await chrome.openPage(`${APP}/join?room=${room}&autojoin=1`));
  }
  const roster = await until(async () => {
    const latest = host.inbox.filter((m) => m.t === "roster").pop();
    return latest && latest.members.length === PHONES ? latest : null;
  }, "phones to join").catch(async (error) => {
    for (const [i, phone] of phones.entries()) {
      console.error(`phone ${i + 1} screen: ${JSON.stringify(await phone.evaluate("document.body.innerText"))}`);
    }
    console.error(`host saw: ${JSON.stringify(host.inbox.map((m) => m.t))}`);
    throw error;
  });
  for (const member of roster.members) host.send({ t: "assign", member: member.id, channel: CHANNEL });

  for (const [i, phone] of phones.entries()) {
    await until(() => phone.evaluate(`document.body.innerText.includes("· synced")`), `phone ${i + 1} clock sync`);
  }
  const label = await phones[0].evaluate(`document.querySelector(".phone-label strong")?.textContent`);
  console.log(`${PHONES} phones joined and synced, all playing channel ${CHANNEL} (${label})`);

  host.send({ t: "play", positionMs: 0 });
  const playback = await host.take("playback", (m) => m.playing);
  const t0 = playback.t0;
  await sleep(LISTEN_MS + 1500);

  // Expected changes within the listened window.
  // On/off per frame of the governed track phone 1 received (all phones play the same light).
  const levels = await phones[0].evaluate("Array.from(window.__lsaTrack?.levels ?? [])");
  const levelAt = (frame) => (levels[frame] >= 128 ? 255 : 0);
  const lastFrame = Math.min(levels.length, Math.floor(LISTEN_MS / stepMs));
  const expected = [];
  for (let f = 1; f < lastFrame; f++) {
    if (levelAt(f) !== levelAt(f - 1)) expected.push({ server: t0 + f * stepMs, level: levelAt(f) });
  }

  const results = [];
  for (const [i, phone] of phones.entries()) {
    const all = await phone.evaluate("JSON.stringify(window.__lsaTransitions ?? [])");
    const transitions = JSON.parse(all).filter((t) => t.server >= t0 && t.server < t0 + LISTEN_MS);
    const errors = expected.map((e) => {
      const match = transitions
        .filter((t) => t.level === e.level)
        .reduce((best, t) => (!best || Math.abs(t.server - e.server) < Math.abs(best.server - e.server) ? t : best), null);
      return match ? match.server - e.server : Infinity;
    });
    results.push({ phone: i + 1, transitions, errors });
  }

  console.log(`\nexpected ${expected.length} light changes in ${LISTEN_MS / 1000} s`);
  let ok = expected.length > 0;
  for (const r of results) {
    const finite = r.errors.filter(Number.isFinite);
    const mean = finite.reduce((a, b) => a + b, 0) / Math.max(1, finite.length);
    const worst = Math.max(...r.errors.map(Math.abs));
    const pass = finite.length === expected.length && worst <= MAX_ERROR_MS;
    ok &&= pass;
    console.log(
      `phone ${r.phone}: ${r.transitions.length} changes seen, matched ${finite.length}/${expected.length}, ` +
        `timing error mean ${mean.toFixed(1)} ms, worst ${worst.toFixed(1)} ms ${pass ? "✓" : "✗"}`,
    );
  }
  const gaps = results[0].errors.map((e, i) => Math.abs(e - results[1].errors[i])).filter(Number.isFinite);
  const worstGap = gaps.length ? Math.max(...gaps) : Infinity;
  const gapPass = worstGap <= MAX_PHONE_GAP_MS;
  if (!ok) {
    for (const [i, phone] of phones.entries()) {
      const frames = await phone.evaluate(
        "new Promise((r) => { let n = 0; const f = () => (++n < 10 ? requestAnimationFrame(f) : r(n)); requestAnimationFrame(f); setTimeout(() => r(n), 1000); })",
      );
      const state = await phone.evaluate(
        "JSON.stringify({ transitions: (window.__lsaTransitions ?? []).length, background: document.querySelector('.phone-light')?.style.backgroundColor })",
      );
      console.error(`phone ${i + 1}: animation frames in 1 s: ${frames}, state ${state}`);
    }
  }
  ok &&= gapPass;
  console.log(`phone 1 vs phone 2: worst difference ${worstGap.toFixed(1)} ms ${gapPass ? "✓" : "✗"}`);
  console.log(ok ? "\nPASS" : "\nFAIL");
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error(`\nERROR: ${error.message}`);
  process.exitCode = 1;
} finally {
  host.ws.close();
  await chrome.close();
}
