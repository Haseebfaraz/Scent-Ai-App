// Fix (InvalidShopError) — a page's own same-origin fetcher submissions always carry an Origin
// header pointing at THIS app's own Render domain, never the real Shopify storefront, so deriving
// "the shop" from request headers only works for endpoints genuinely called cross-origin from the
// storefront theme (e.g. api.save-build.jsx). For a route calling itself (fragrance-preview.jsx),
// the one real shop this custom app is installed on lives in the Session table from the moment
// OAuth completed — that's the actual source of truth, not anything derivable from a same-origin
// request's own headers.
import prisma from "../db.server.js";

const DEFAULT_SHOP_DOMAIN = "test-3d-products.myshopify.com";

export async function resolveShopDomain() {
  const session = await prisma.session.findFirst({ where: { isOnline: false }, orderBy: { id: "desc" } });
  return session?.shop || DEFAULT_SHOP_DOMAIN;
}
