// Fix (InvalidShopError) — a page's own same-origin fetcher submissions always carry an Origin
// header pointing at THIS app's own Render domain, never the real Shopify storefront, so deriving
// "the shop" from request headers only works for endpoints genuinely called cross-origin from the
// storefront theme (e.g. api.save-build.jsx). Used by previewUrl.server.js, which builds an
// outbound preview link with no incoming Shopify request to verify a shop from — the one real shop
// this custom app is installed on lives in the Session table from the moment OAuth completed,
// which is the actual source of truth there. (api.fragrance-preview.jsx itself doesn't need this —
// it gets a cryptographically verified shop straight from authenticate.public.appProxy.)
import prisma from "../db.server.js";

const DEFAULT_SHOP_DOMAIN = "test-3d-products.myshopify.com";

export async function resolveShopDomain() {
  const session = await prisma.session.findFirst({ where: { isOnline: false }, orderBy: { id: "desc" } });
  return session?.shop || DEFAULT_SHOP_DOMAIN;
}
