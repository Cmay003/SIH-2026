import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

// Multi-page build: each page keeps the SAME URL as the old public/ page,
// so server.js decides who may load it (login/role checks stay server-side;
// nothing in the browser is trusted for access control).
// Pages are added here as they are migrated.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        index: `${root}index.html`, // dashboard
        login: `${root}login.html`,
        officer: `${root}officer.html`,
        sos: `${root}sos.html`, // citizen page: keep its bundle small (no map, no auth code)
      },
    },
  },
  server: {
    port: 5173,
    // `npm run dev`: the API (and its session cookie) come from server.js
    proxy: { "/api": "http://localhost:3000" },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
  },
});
