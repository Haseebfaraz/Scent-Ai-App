import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Related: https://github.com/remix-run/remix/issues/2835#issuecomment-1144102176
// Replace the HOST env var with SHOPIFY_APP_URL so that it doesn't break the Vite server.
// The CLI will eventually stop passing in HOST,
// so we can remove this workaround after the next major release.
if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost")
  .hostname;
let hmrConfig;

if (host === "localhost") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  hmrConfig = {
    protocol: "wss",
    host: host,
    port: parseInt(process.env.FRONTEND_PORT) || 8002,
    clientPort: 443,
  };
}

export default defineConfig(({ command }) => ({
  // Fix (dead preview page behind the App Proxy) — confirmed live: entry.client/root/route JS all
  // 404'd once this app was reached via https://{shop}/apps/scent-library/..., because Vite's
  // default root-relative asset URLs ("/assets/...") resolve against whatever origin served the
  // HTML — the storefront domain in that case, not this app. An absolute base makes every built
  // asset URL point at this app's own origin regardless of what domain/path proxies the page.
  //
  // Hardcoded rather than read from SHOPIFY_APP_URL: the Dockerfile's `RUN npm run build` runs
  // during the image build, before Render injects any dashboard env var into the container, so
  // process.env.SHOPIFY_APP_URL is always empty at exactly the point this needs it (confirmed —
  // the Dockerfile declares no ARG/ENV bridge for it). Matches the same URL this codebase already
  // hardcodes in shopify.app.shop-chat-agent.toml's application_url. Only applied for `command ===
  // "build"` — local/tunnel dev (`shopify app dev`) keeps serving its own assets from "/" exactly
  // as before; forcing the production origin there would break HMR.
  base: command === "build" ? "https://scent-ai-app.onrender.com/" : "/",
  server: {
    allowedHosts: [host],
    cors: {
      preflightContinue: true,
    },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      // See https://vitejs.dev/config/server-options.html#server-fs-allow for more information
      allow: ["app", "node_modules"],
    },
  },
  plugins: [reactRouter(), tsconfigPaths()],
  build: {
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react"],
  },
}));
