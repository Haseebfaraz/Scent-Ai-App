// Fix (customer-facing preview URL should be the merchant's own store domain) — previewUrl must
// always be an absolute URL under the Shopify App Proxy path on the real installed shop's own
// domain, never this app's own Render domain and never a relative path (the chat widget runs on
// the storefront domain, so a relative path would resolve against the wrong origin).
import { describe, it, expect } from "vitest";
import { buildPreviewUrl } from "./previewUrl.server.js";
import { resolveShopDomain } from "../services/shopDomain.server.js";

describe("buildPreviewUrl", () => {
  it("builds an absolute App Proxy URL on the real shop's own domain with the recommendationId as a query param", async () => {
    const shopDomain = await resolveShopDomain();
    const url = await buildPreviewUrl("abc123");
    expect(url).toBe(`https://${shopDomain}/apps/scent-library/fragrance-preview?recommendationId=abc123`);
    expect(() => new URL(url)).not.toThrow();
  });
});
