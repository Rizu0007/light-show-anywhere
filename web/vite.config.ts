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
  },
});
