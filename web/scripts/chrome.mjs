// Shared helpers for the browser tests: waiting, and a minimal Chrome DevTools client that
// opens real headless-Chrome pages.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** Extra command-line flags, space-separated (CI: `--no-sandbox`, where Linux blocks Chrome's). */
const CHROME_FLAGS = (process.env.CHROME_FLAGS ?? "").split(" ").filter(Boolean);
const DEBUG_PORT = 9333;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(check, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Starts headless Chrome; `extraArgs` are added to its command line. */
export async function chromeSession(extraArgs = []) {
  const profile = mkdtempSync(join(tmpdir(), "lsa-e2e-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--ignore-certificate-errors",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    ...CHROME_FLAGS,
    ...extraArgs,
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
