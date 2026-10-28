import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Lets the dev shortcut (?show=/@fs/...) read shows from the repository's shows/ folder.
    fs: { allow: [repoRoot] },
    // Party server (cargo run -p lsa-server) on the same origin, so phones need one address.
    proxy: { "/ws": { target: "ws://localhost:8787", ws: true } },
  },
});
