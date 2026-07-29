// Fix (absolute preview URL) — the chat widget runs on the Shopify storefront domain, while the
// fragrance-preview route lives on this app's own Render domain. A relative "/fragrance-preview..."
// URL resolves against the WRONG origin (the storefront) once the widget navigates with it — every
// place that builds a preview_ready event's previewUrl must go through this one function instead of
// hand-building the path, so there's exactly one place that knows the app's own public origin.
export function buildPreviewUrl(recommendationId) {
  const appBaseUrl = process.env.SHOPIFY_APP_URL || process.env.APP_URL;
  if (!appBaseUrl) {
    throw new Error("Missing public application URL (SHOPIFY_APP_URL or APP_URL) — cannot build an absolute preview URL.");
  }
  const url = new URL("/fragrance-preview", appBaseUrl);
  url.searchParams.set("recommendationId", recommendationId);
  return url.toString();
}
