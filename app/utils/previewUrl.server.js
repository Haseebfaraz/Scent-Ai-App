// Fix (customer-facing preview URL should be the merchant's own store domain) — the chat widget
// runs on the storefront domain, and the fragrance-preview page now lives behind the Shopify App
// Proxy (see shopify.app.toml's [app_proxy]: prefix "apps", subpath "scent-library", pointed at
// this app's /api routes) instead of being linked directly to this app's own Render domain. Every
// place that builds a preview_ready event's previewUrl goes through this one function, so there's
// exactly one place that knows the proxy path and the real shop domain.
import { resolveShopDomain } from "../services/shopDomain.server.js";

export async function buildPreviewUrl(recommendationId) {
  const shopDomain = await resolveShopDomain();
  const url = new URL(`https://${shopDomain}/apps/scent-library/fragrance-preview`);
  url.searchParams.set("recommendationId", recommendationId);
  return url.toString();
}
