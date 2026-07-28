import { defineConfig } from "vitest/config";

// Separate from vite.config.js (which wires in the React Router + Shopify plugins the app's dev
// server needs) — tests only need plain Node module resolution, and a separate config avoids
// pulling react-router's route-convention plugin into the test run at all.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.js"],
    exclude: ["node_modules/**", "build/**"],
    testTimeout: 20000,
    setupFiles: ["./vitest.setup.js"],
  },
});
