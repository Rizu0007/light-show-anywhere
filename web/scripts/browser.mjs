// Shared helpers for the browser tests: waiting, and real browser pages to drive. Headless Chrome
// by default (DevTools protocol); BROWSER=safari drives Safari through safaridriver (WebDriver),
// which needs Safari's Developer setting "Allow remote automation".

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** Starts the browser; `chromeArgs` are added to Chrome's command line. */
export function browserSession(chromeArgs = []) {
  return process.env.BROWSER === "safari" ? safariSession() : chromeSession(chromeArgs);
}

async function chromeSession(extraArgs) {
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
      /** Saves a PNG of the page, `width` × `height` CSS pixels. */
      const screenshot = async (path, width = 1200, height = 900) => {
        await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
        const { data } = await call("Page.captureScreenshot", { format: "png" }, sessionId);
        writeFileSync(path, Buffer.from(data, "base64"));
      };
      return { evaluate, screenshot };
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

const SAFARI_PORT = 4445;

/** Safari through safaridriver. Pages are separate windows (background tabs are throttled). */
async function safariSession() {
  const driver = spawn("safaridriver", ["-p", String(SAFARI_PORT)], { stdio: "ignore" });
  const base = `http://127.0.0.1:${SAFARI_PORT}`;
  const request = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const { value } = await response.json();
    if (value?.error) throw new Error(`safaridriver: ${value.message}`);
    return value;
  };
  await until(() => fetch(`${base}/status`).then((r) => r.ok).catch(() => false), "safaridriver to start");
  const { sessionId } = await request("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } });
  const session = (path) => `/session/${sessionId}${path}`;
  await request("POST", session("/timeouts"), { script: 300000, pageLoad: 60000 });

  // One command at a time, each in its page's window.
  let queue = Promise.resolve();
  let current = await request("GET", session("/window"));
  let firstUnused = true;
  const inWindow = (handle, command) => {
    const run = queue.then(async () => {
      if (current !== handle) {
        await request("POST", session("/window"), { handle });
        current = handle;
      }
      return command();
    });
    queue = run.catch(() => {});
    return run;
  };

  return {
    async openPage(url) {
      let handle = current;
      if (!firstUnused) handle = (await inWindow(current, () => request("POST", session("/window/new"), { type: "window" }))).handle;
      firstUnused = false;
      await inWindow(handle, () => request("POST", session("/url"), { url }));
      const evaluate = async (expression) => {
        const script = `const done = arguments[arguments.length - 1];
          Promise.resolve().then(() => (${expression})).then((value) => done({ value }), (e) => done({ error: String(e) }));`;
        const result = await inWindow(handle, () => request("POST", session("/execute/async"), { script, args: [] }));
        if (result?.error) throw new Error(result.error);
        return result?.value;
      };
      const screenshot = async (path, width = 1200, height = 900) => {
        await inWindow(handle, () => request("POST", session("/window/rect"), { width, height }));
        const data = await inWindow(handle, () => request("GET", session("/screenshot")));
        writeFileSync(path, Buffer.from(data, "base64"));
      };
      return { evaluate, screenshot };
    },
    async close() {
      await request("DELETE", session("")).catch(() => {});
      driver.kill();
    },
  };
}
