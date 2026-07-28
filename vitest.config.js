import { defineConfig } from "vitest/config";

// Separate from vite.config.js (which wires in the React Router + Shopify plugins the app's dev
// server needs) — tests only need plain Node module resolution, and a separate config avoids
// pulling react-router's route-convention plugin into the test run at all.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.js"],
    exclude: ["node_modules/**", "build/**"],
    // Bumped from 20000 — verified this suite genuinely needs it under full concurrent-file load
    // against the real remote (Virginia) Postgres instance: several individually-fast real-DB/
    // real-geocoding tests intermittently cleared 20s but not by a comfortable margin once every
    // test file runs at once, with no logic bug involved (same tests pass instantly in isolation).
    testTimeout: 45000,
    setupFiles: ["./vitest.setup.js"],
  },
});
