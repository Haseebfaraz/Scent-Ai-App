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
  // Fix (dead preview page behind the App Proxy) — confirmed live, in two stages:
  // 1. Vite's default root-relative asset URLs ("/assets/...") resolve against whatever origin
  //    served the HTML — the storefront domain once this app is reached via
  //    https://{shop}/apps/scent-library/..., not this app — so entry.client/root/route JS all
  //    404'd and no client JS ever ran.
  // 2. Pointing `base` at this app's own absolute Render origin instead (the first fix attempt)
  //    made the files load, but a cross-origin <script type="module"> is always fetched with CORS,
  //    and this server sends no Access-Control-Allow-Origin header — so the browser fetched the
  //    file successfully and then refused to execute it.
  // Using the App Proxy's own relative path as `base` instead avoids both: the browser now
  // requests assets through the SAME origin that served the page (the store domain, relayed by
  // Shopify's proxy) rather than cross-origin, so CORS never applies. This also needs no server
  // changes — react-router-serve mounts its static-asset middleware at this exact same `base`
  // value (see build.publicPath in its cli.js), so it starts serving assets at
  // /apps/scent-library/assets automatically. Must match shopify.app.shop-chat-agent.toml's
  // [app_proxy] prefix ("apps") + subpath ("scent-library") exactly. Direct (non-proxied) access
  // to this app's other pages (the embedded admin UI, etc.) is unaffected: their own script tags
  // become same-origin-relative to /apps/scent-library/assets/... too, which this same server
  // still serves correctly regardless of which page asked for it.
  base: command === "build" ? "/apps/scent-library/" : "/",
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
