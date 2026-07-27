import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // amazon-cognito-identity-js still references Node's `global` from its
  // browser bundle. Keep the browser entrypoint deterministic in both Vite's
  // dependency prebundle and the application build.
  define: {
    global: "globalThis",
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: "globalThis",
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
