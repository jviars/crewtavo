import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs separately (`npm run dev:api` on :8787) and Vite proxies to it. In
// production the server (apps/api/src/server.ts) serves both from one origin.
const API = process.env.CREWTAVO_API_URL ?? "http://localhost:8787";

/**
 * Libraries in their own files: they change less often than the app, so browsers keep them cached
 * across deploys, and they download in parallel with the app's own code. Matched by package name.
 */
const VENDOR_CHUNKS: Record<string, RegExp> = {
  react: /^(react|react-dom|scheduler|react-router|react-router-dom|@remix-run\/router|@tanstack\/[^/]+)$/,
  supabase: /^@supabase\//,
  charts: /^(recharts|victory-vendor|d3-[^/]+|internmap|@reduxjs\/toolkit|react-redux|redux|redux-thunk|immer|reselect|decimal\.js-light|es-toolkit|eventemitter3|tiny-invariant)$/,
};

function vendorChunk(id: string): string | undefined {
  const name = id.match(/.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1];
  if (!name) return undefined;
  return Object.keys(VENDOR_CHUNKS).find((chunk) => VENDOR_CHUNKS[chunk]!.test(name));
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    // The Word editor (features/files/DocxEdit.tsx) loads its text shaper with a top-level await.
    // The app already needs Safari 17+ for its popover menus, so this costs no one.
    target: ["es2022", "chrome89", "edge89", "firefox89", "safari15"],
    rollupOptions: { output: { manualChunks: vendorChunk } },
  },
  // laz-perf (Measure's lidar pitch) is CommonJS and only loaded on demand: bundle it up front so the
  // dev server doesn't stop to do it the first time someone asks. The Word editor's fonts are files it
  // finds next to itself, so the dev server serves that package as it is.
  optimizeDeps: { include: ["laz-perf"], exclude: ["@docx-editor.dev/fonts"], esbuildOptions: { target: "es2022" } },
  server: {
    port: 5173,
    proxy: {
      "^/(api|mcp|\\.well-known)(/|$)": { target: API, changeOrigin: true },
      // Website analytics: the script for the business's website and its page views.
      "^/v(\\.js)?$": { target: API, changeOrigin: true },
      // Website forms: the address the business's own form sends to, and its thank-you page.
      "^/f/": { target: API, changeOrigin: true },
    },
  },
});
