// Fix (absolute preview URL) — the chat widget runs on the Shopify storefront domain, so
// previewUrl must always be an absolute URL on this app's own domain, never a relative path that
// would resolve against the wrong origin.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildPreviewUrl } from "./previewUrl.server.js";

describe("buildPreviewUrl", () => {
  const originalAppUrl = process.env.SHOPIFY_APP_URL;
  const originalFallback = process.env.APP_URL;

  afterEach(() => {
    process.env.SHOPIFY_APP_URL = originalAppUrl;
    process.env.APP_URL = originalFallback;
  });

  it("builds an absolute URL on the app's configured domain with the recommendationId as a query param", () => {
    process.env.SHOPIFY_APP_URL = "https://scent-ai-app.onrender.com";
    const url = buildPreviewUrl("abc123");
    expect(url).toBe("https://scent-ai-app.onrender.com/fragrance-preview?recommendationId=abc123");
    expect(() => new URL(url)).not.toThrow();
  });

  it("falls back to APP_URL when SHOPIFY_APP_URL isn't set", () => {
    delete process.env.SHOPIFY_APP_URL;
    process.env.APP_URL = "https://fallback-app.example.com";
    const url = buildPreviewUrl("xyz789");
    expect(url).toBe("https://fallback-app.example.com/fragrance-preview?recommendationId=xyz789");
  });

  it("throws rather than emitting a relative or guessed URL when no public app URL is configured", () => {
    delete process.env.SHOPIFY_APP_URL;
    delete process.env.APP_URL;
    expect(() => buildPreviewUrl("abc123")).toThrow(/Missing public application URL/);
  });
});
