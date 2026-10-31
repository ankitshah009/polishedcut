import path from "node:path";

import { defineConfig } from "vitest/config";

// Mirrors tsconfig "paths": route handlers import "@/lib/..." and are tested directly.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: { include: ["tests/**/*.test.ts"] },
});
