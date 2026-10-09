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
        admin: `${root}admin.html`, // node registry (admin role only - checked by server.js)
        sos: `${root}sos.html`, // citizen page: keep its bundle small (no map, no auth code)
      },
    },
  },
  server: {
    port: 5173,
    // `npm run dev`: the API (and its session cookie) come from server.js
    proxy: { "/api": "http://localhost:3000" },
    // The SOS page bundles ../data/hazard_advice.json (one advice table
    // shared with server.js); the dev server only serves files from the
    // allowed folders, so that one data file is added explicitly.
    fs: { allow: [root, fileURLToPath(new URL("../data/hazard_advice.json", import.meta.url))] },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    // Page tests that type into forms and run axe take 2-4 s; on a busy PC
    // (a full run once took 82 s) a few hit the 5 s default and failed
    // once at random. 15 s keeps them from flaking; real hangs still fail.
    testTimeout: 15_000,
  },
});
