import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// `npm run dev:https`: serve over HTTPS with the certificate `lsa-server --tls` keeps in .lsa-tls/
// (start the server first), so phones can keep the screen awake and use the flashlight.
const https = process.env.LSA_HTTPS
  ? {
      cert: readFileSync(`${repoRoot}.lsa-tls/cert.pem`),
      key: readFileSync(`${repoRoot}.lsa-tls/key.pem`),
    }
  : undefined;

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Lets the dev shortcut (?show=/@fs/...) read shows from the repository's shows/ folder.
    fs: { allow: [repoRoot] },
    https,
    // Party server (cargo run -p lsa-server) on the same origin, so phones need one address.
    // Its certificate is self-signed, so the proxy does not verify it.
    proxy: { "/ws": { target: https ? "wss://localhost:8787" : "ws://localhost:8787", ws: true, secure: false } },
  },
});
