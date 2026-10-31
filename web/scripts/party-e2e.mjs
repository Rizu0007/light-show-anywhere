#!/usr/bin/env node
// Party test: a host bot and headless-Chrome phones on one light; checks each light change against
// the track's frame times. Needs lsa-server and `npm run dev`. DROP=1 cuts phone 1 mid-show;
// START_S plays from that second; LAYOUT=1 gives each phone a place. A folder of
// "Car #n/lightshow.fseq" is a fleet: phone n, car n.
//   node scripts/party-e2e.mjs <show.fseq | fleet folder> [channel] [seconds]

import { readFileSync, statSync } from "node:fs";
import { browserSession, sleep, until } from "./browser.mjs";

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
const START_MS = Number(process.env.START_S ?? 0) * 1000;
const FLEET = statSync(showPath).isDirectory();
const LAYOUT = !!process.env.LAYOUT;

const files = (FLEET ? Array.from({ length: PHONES }, (_, i) => `${showPath}/Car #${i + 1}/lightshow.fseq`) : [showPath]).map(
  (path) => new Uint8Array(readFileSync(path)),
);
const view = new DataView(files[0].buffer);
const channelCount = view.getUint32(10, true);
const frameCount = view.getUint32(14, true);

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
const chrome = await browserSession();
try {
  await host.opened;
  host.send({ t: "create" });
  const { room } = await host.take("created");
  const sizes = FLEET ? files.map((f) => f.length) : [];
  host.send({ t: "load", vehicle: "model-3y", name: "e2e", sizes });
  host.ws.send(new Uint8Array(files.flatMap((f) => Array.from(f))));
  const { cars } = await host.take("show");
  if (LAYOUT) {
    // One place per phone, side by side, all on the tested light.
    const spots = Array.from({ length: PHONES }, (_, i) => ({ x: (i + 0.5) / PHONES, y: 0.5, car: FLEET ? i + 1 : 1, channel: CHANNEL }));
    host.send({ t: "layout", spots });
  }
  console.log(`room ${room}: show loaded (${cars} car(s), car 1: ${frameCount} frames × ${channelCount} channels)`);

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
  // With a layout the places already carry the light.
  if (!LAYOUT) {
    for (const [i, member] of roster.members.entries()) {
      host.send({ t: "assign", member: member.id, car: FLEET ? i + 1 : 1, channel: CHANNEL });
    }
  }

  for (const [i, phone] of phones.entries()) {
    await until(() => phone.evaluate(`document.body.innerText.includes("· synced")`), `phone ${i + 1} clock sync`);
  }
  const label = await phones[0].evaluate(`document.querySelector(".phone-label strong")?.textContent`);
  console.log(`${PHONES} phones joined and synced, all playing channel ${CHANNEL} (${label})${FLEET ? ", one per car" : ""}`);
  if (LAYOUT) {
    // Each phone shows its own place (join order decides which) and a map with its dot.
    const shown = [];
    for (const [i, phone] of phones.entries()) {
      shown.push(
        await until(
          () => phone.evaluate(`document.querySelector(".phone-map-mine") && document.querySelector(".phone-car")?.textContent`),
          `phone ${i + 1} to show its place`,
        ),
      );
    }
    const every = Array.from({ length: PHONES }, (_, i) => `Place ${i + 1}`);
    if (shown.slice().sort().join() !== every.join()) throw new Error(`phones show ${shown.join(", ")}`);
    console.log(`phones show ${shown.join(", ")} with a map`);
  } else if (FLEET) {
    // Guests find their car's group by the number on screen (join order decides which car).
    const shown = [];
    for (const [i, phone] of phones.entries()) {
      shown.push(await until(() => phone.evaluate(`document.querySelector(".phone-car")?.textContent`), `phone ${i + 1} to show its car`));
    }
    const every = Array.from({ length: PHONES }, (_, i) => `Car ${i + 1}`);
    if (shown.slice().sort().join() !== every.join()) throw new Error(`phones show ${shown.join(", ")}`);
  }

  // Each phone reports its health to the host's roster.
  // Browsers count localhost as secure even over http.
  const secure = APP.startsWith("https:") || new URL(APP).hostname === "localhost";
  const reported = await until(() => {
    const latest = host.inbox.filter((m) => m.t === "roster").pop();
    const ok = latest?.members.every((m) => m.health?.synced && m.health.secure === secure);
    return ok ? latest : null;
  }, "phone status in the host's roster");
  for (const [i, m] of reported.members.entries()) console.log(`phone ${i + 1} reports ${JSON.stringify(m.health)}`);

  host.send({ t: "play", positionMs: START_MS });
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
    // Roster order is join order, which is not page order: count the phones that reconnected.
    const reconnects = back?.members.map((m) => m.health?.reconnects ?? 0) ?? [];
    const counted = reconnects.filter((n) => n >= 1).length === 1;
    console.log(
      `phone 1 connected ${opens} times; host roster: ${online ? "both online on the same light" : JSON.stringify(back)}` +
        `, reconnects reported: ${reconnects.join(", ")}`,
    );
    reconnected = opens >= 2 && online && counted;
  } else {
    await sleep(LISTEN_MS + 1500);
  }

  // Expected on/off changes in the listened window, from the governed track each phone received
  // (its own car's in a fleet).
  const from = t0 + START_MS;
  const results = [];
  for (const [i, phone] of phones.entries()) {
    const track = JSON.parse(
      await phone.evaluate("JSON.stringify({ stepMs: window.__lsaTrack?.stepMs, levels: Array.from(window.__lsaTrack?.levels ?? []) })"),
    );
    const levelAt = (frame) => (track.levels[frame] >= 128 ? 255 : 0);
    const firstFrame = Math.ceil(START_MS / track.stepMs) + 1;
    const lastFrame = Math.min(track.levels.length, Math.floor((START_MS + LISTEN_MS) / track.stepMs));
    const expected = [];
    for (let f = firstFrame; f < lastFrame; f++) {
      if (levelAt(f) !== levelAt(f - 1)) expected.push({ server: t0 + f * track.stepMs, level: levelAt(f) });
    }
    const all = await phone.evaluate("JSON.stringify(window.__lsaTransitions ?? [])");
    const transitions = JSON.parse(all).filter((t) => t.server >= from && t.server < from + LISTEN_MS);
    const errors = expected.map((e) => {
      const match = transitions
        .filter((t) => t.level === e.level)
        .reduce((best, t) => (!best || Math.abs(t.server - e.server) < Math.abs(best.server - e.server) ? t : best), null);
      return match ? match.server - e.server : Infinity;
    });
    results.push({ phone: i + 1, transitions, errors, expected: expected.length });
  }

  console.log(`\nlistened ${LISTEN_MS / 1000} s from ${START_MS / 1000} s`);
  let ok = reconnected;
  for (const r of results) {
    const finite = r.errors.filter(Number.isFinite);
    const mean = finite.reduce((a, b) => a + b, 0) / Math.max(1, finite.length);
    const worst = Math.max(...r.errors.map(Math.abs));
    const pass = r.expected > 0 && finite.length === r.expected && worst <= MAX_ERROR_MS;
    ok &&= pass;
    console.log(
      `phone ${r.phone}: ${r.transitions.length} changes seen, matched ${finite.length}/${r.expected}, ` +
        `timing error mean ${mean.toFixed(1)} ms, worst ${worst.toFixed(1)} ms ${pass ? "✓" : "✗"}`,
    );
  }
  // Phones on the same light should change together (in a fleet they play different tracks).
  const gaps = results[0].errors.map((e, i) => Math.abs(e - results[1].errors[i])).filter(Number.isFinite);
  const worstGap = gaps.length ? Math.max(...gaps) : Infinity;
  const gapPass = FLEET || worstGap <= MAX_PHONE_GAP_MS;
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
  if (!FLEET) console.log(`phone 1 vs phone 2: worst difference ${worstGap.toFixed(1)} ms ${gapPass ? "✓" : "✗"}`);
  console.log(ok ? "\nPASS" : "\nFAIL");
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error(`\nERROR: ${error.message}`);
  process.exitCode = 1;
} finally {
  host.ws.close();
  await chrome.close();
}
