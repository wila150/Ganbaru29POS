import { writeFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { LATEST } from "./src/lib/changelog";

// Every build gets an id; dist/version.json lets open apps (iPad home-screen app) notice a new deploy.
const BUILD_ID = new Date().toISOString();

export default defineConfig({
  plugins: [
    react(),
    {
      name: "write-version",
      apply: "build",
      closeBundle() {
        writeFileSync("dist/version.json", JSON.stringify({ build: BUILD_ID, notes: LATEST }));
      },
    },
  ],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  // fs.allow: the promotion engine is shared with functions/src/shared
  server: { host: true, port: 5173, fs: { allow: [".."] } },
});
