// Low-level HTTP wrapper around the custom Odoo REST API — read-only. No Prisma, no Shopify calls,
// no recommendation logic (that lives in odooInventory.server.js / fragranceFormula.server.js).
// Server-only (.server.js) — Odoo must never be reachable from the browser/theme JS.
// Fix (sandbox renewal) — the "5aug" trial sandbox stopped resolving via DNS entirely on
// 2026-08-12 (confirmed: getaddrinfo ENOENT, while the parent dev.odoo.com domain resolved fine) —
// consistent with a short-lived Odoo trial database expiring. Replaced with the "12aug" renewal.
// These defaults are only ever used if the env var itself is unset — always prefer setting
// ODOO_PING_URL/ODOO_INVENTORY_URL in the real environment (.env locally, Render in production)
// over relying on this fallback.
const ODOO_PING_URL = process.env.ODOO_PING_URL || "https://the-dua-brand-sandbox-12aug-36292701.dev.odoo.com/api/v1/dua-ai/ping";
// Confirmed real endpoint (2026-08-11) — a different path/host structure than the ping endpoint,
// not nested under /api/v1/dua-ai. Takes a comma-separated `skus` query param and returns ALL of
// them in one response — genuinely batched, not simulated with parallel single-SKU calls.
const ODOO_INVENTORY_URL = process.env.ODOO_INVENTORY_URL || "https://the-dua-brand-sandbox-12aug-36292701.dev.odoo.com/api/get-inventory";
// Fix (real, measured latency) — a candidate combination is checked before it's known to be the
// winner, and there's no cap on how long Odoo can take to answer. Confirmed live: an uncapped call
// against a slow/misrouted endpoint let a single generation turn balloon past 30s. This bounds the
// worst case per call — a slow/hung Odoo never blocks the chat turn indefinitely.
const REQUEST_TIMEOUT_MS = 8000;

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
    const response = await fetch(url, { method: "GET", headers: authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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
 * (never fuzzy product-name matching). Genuinely batched: multiple SKUs go in ONE request via a
 * comma-separated `skus` param, confirmed against the real endpoint. Returns the raw HTTP/JSON
 * result; normalization into ml and a stock status happens in odooInventory.server.js, not here.
 * @param {string[]} skus
 */
export async function getInventoryBySkus(skus) {
  if (!skus?.length) return { ok: false, status: null, durationMs: 0, error: "at least one sku is required." };
  const url = `${ODOO_INVENTORY_URL}?skus=${encodeURIComponent(skus.join(","))}`;
  return getJson(url);
}
