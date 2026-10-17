import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // fs.allow: the promotion engine is shared with functions/src/shared
  server: { host: true, port: 5173, fs: { allow: [".."] } },
});
