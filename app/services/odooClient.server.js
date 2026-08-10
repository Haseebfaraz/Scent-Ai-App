// Low-level HTTP wrapper around the custom Odoo REST API — read-only. No Prisma, no Shopify calls,
// no recommendation logic (that lives in odooInventory.server.js / fragranceFormula.server.js).
// Server-only (.server.js) — Odoo must never be reachable from the browser/theme JS.
//
// During current local/sandbox development, no Authorization header is required. When
// ODOO_INVENTORY_API_KEY is set, it's sent as a Bearer token automatically — nothing else in this
// file (or its callers) needs to change once real auth is turned on.
const ODOO_API_BASE_URL = process.env.ODOO_API_BASE_URL || "https://the-dua-brand-sandbox-5aug-35949002.dev.odoo.com/api/v1/dua-ai";
const ODOO_PING_URL = process.env.ODOO_PING_URL || `${ODOO_API_BASE_URL}/ping`;

function authHeaders() {
  const headers = { Accept: "application/json" };
  if (process.env.ODOO_INVENTORY_API_KEY) {
    headers.Authorization = `Bearer ${process.env.ODOO_INVENTORY_API_KEY}`;
  }
  return headers;
}

async function getJson(url) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { method: "GET", headers: authHeaders() });
    const bodyText = await response.text();
    let json = null;
    try {
      json = JSON.parse(bodyText);
    } catch {
      // Malformed/non-JSON response (e.g. an HTML 404 page) — never guess, surface it as-is.
    }
    return { ok: response.ok, status: response.status, durationMs: Date.now() - startedAt, body: bodyText, json };
  } catch (error) {
    return { ok: false, status: null, durationMs: Date.now() - startedAt, error: error?.message || String(error) };
  }
}

export async function pingOdoo() {
  return getJson(ODOO_PING_URL);
}

/**
 * Inventory lookup by SKU / Internal Reference — the primary, approved production lookup key
 * (never fuzzy product-name matching). Returns the raw HTTP/JSON result; normalization into ml and
 * a stock status happens in odooInventory.server.js, not here.
 * @param {string} sku
 */
export async function getInventoryBySku(sku) {
  if (!sku) return { ok: false, status: null, durationMs: 0, error: "sku is required." };
  const url = `${ODOO_API_BASE_URL}/inventory?sku=${encodeURIComponent(sku)}`;
  return getJson(url);
}
