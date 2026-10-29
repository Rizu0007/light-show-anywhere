#!/usr/bin/env node
// End-to-end party test: a scripted host plus real headless-Chrome phones.
//
// Needs `cargo run -p lsa-server` and `npm run dev` running. Usage:
//   node scripts/party-e2e.mjs <show.fseq> [channel] [seconds]
// Over HTTPS (`lsa-server --tls` and `npm run dev:https`): APP=https://localhost:5173 node ...
// DROP=1 cuts phone 1's connection halfway through; it must reconnect, take its place back and
// keep every light change in time.
//
// The host bot creates a room, uploads the show, pins every phone to the same light and plays.
// Each phone records when its light crosses half brightness on the shared clock; the script
// compares those moments with the frame timing of the track the phone received (the show after
// the safety governor) and with each other.

import { readFileSync } from "node:fs";
import { chromeSession, sleep, until } from "./chrome.mjs";

const [showPath, channelArg = "21", secondsArg = "10"] = process.argv.slice(2);
if (!showPath) {
  console.error("usage: node scripts/party-e2e.mjs <show.fseq> [channel] [seconds]");
  process.exit(2);
}
const CHANNEL = Number(channelArg);
const LISTEN_MS = Number(secondsArg) * 1000;
const PHONES = 2;
const APP = process.env.APP ?? "http://localhost:5173";
// The party certificate is self-signed; trust it for this test only.
if (APP.startsWith("https:")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const MAX_ERROR_MS = 40; // one 20 ms frame plus one 60 Hz screen refresh, with margin
const MAX_PHONE_GAP_MS = 20;
const DROP = !!process.env.DROP;

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
  let reconnected = true;
  if (DROP) {
    await sleep(1000 + LISTEN_MS / 2);
    await phones[0].evaluate("window.__lsaDrop()");
    console.log(`cut phone 1's connection at ${LISTEN_MS / 2000} s`);
    await sleep(LISTEN_MS / 2 + 500);
    const opens = await phones[0].evaluate("window.__lsaOpens");
    const back = host.inbox.filter((m) => m.t === "roster").pop();
    const online = back?.members.length === PHONES && back.members.every((m) => m.online && m.channel === CHANNEL);
    console.log(`phone 1 connected ${opens} times; host roster: ${online ? "both online on the same light" : JSON.stringify(back)}`);
    reconnected = opens >= 2 && online;
  } else {
    await sleep(LISTEN_MS + 1500);
  }

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
  let ok = expected.length > 0 && reconnected;
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
