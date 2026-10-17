import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for pure logic (no React plugin or dev-server proxy needed).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"] },
});
