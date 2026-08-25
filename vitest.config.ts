import { defineConfig, defaultExclude } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    exclude: [...defaultExclude, ".claude/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
