import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{core,engine,adapters,frontends,hosts,tests}/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
