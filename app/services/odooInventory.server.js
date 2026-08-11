// Normalizes raw Odoo API responses into ml and a stock status, and resolves the DUA product ->
// Odoo SKU mapping — hides both from recommendation logic, which should only ever see clean
// { availableOilMl, stockStatus, ... } facts, never a raw HTTP/JSON shape or a bare mapping row.
//
// Real confirmed response shape (2026-08-11, GET /api/get-inventory?skus=A,B,C):
//   { "success": true, "products": [{ "name": "...", "default_code": "SKU", "on_hand_qty": 0.0 }] }
// Two real limitations this file works around rather than papers over:
//   - No reserved/available split — only on_hand_qty. Treated directly as the usable quantity;
//     there is currently no way to exclude reserved stock because Odoo doesn't expose it here.
//   - No unit of measure field — ASSUMED to already be ml (the doc's stated production unit for
//     fragrance oil). Flagged in mappingStatus reasoning below; confirm with the Odoo coworker
//     before trusting this at scale.
// A requested SKU absent from the returned `products` array is SKU_NOT_FOUND, matched by
// `default_code` (Odoo's field name for what this app calls a SKU).
import prisma from "../db.server.js";
import { getInventoryBySkus } from "./odooClient.server.js";
import { normalizeProductName } from "../utils/fragranceNormalization.js";

// Buildable-bottle-count thresholds, not arbitrary raw ml — a status is only meaningful relative to
// how many bottles it can actually produce. Kept here (not hardcoded into callers) so they can be
// tuned without touching feasibility logic.
const STOCK_STATUS_THRESHOLDS = { IN_STOCK: 21, LOW_STOCK: 6, CRITICAL: 1 };
export function classifyStockStatus(maximumBuildableBottles) {
  if (maximumBuildableBottles == null || Number.isNaN(maximumBuildableBottles)) return "UNKNOWN";
  if (maximumBuildableBottles >= STOCK_STATUS_THRESHOLDS.IN_STOCK) return "IN_STOCK";
  if (maximumBuildableBottles >= STOCK_STATUS_THRESHOLDS.LOW_STOCK) return "LOW_STOCK";
  if (maximumBuildableBottles >= STOCK_STATUS_THRESHOLDS.CRITICAL) return "CRITICAL";
  return "OUT_OF_STOCK";
}

// Fix (real, measured redundancy) — the same anchor/support product recurs across many ranked
// candidates; a short-lived in-memory cache, keyed by normalized title, is exactly what the spec's
// own cache section calls for ("60 second... cache normalized inventory keyed by SKU") — never
// indefinite, and Save Build/Add to Cart (not built on this function) must bypass it with a fresh
// check when they're wired in later.
const CACHE_TTL_MS = Number(process.env.ODOO_INVENTORY_CACHE_TTL_SECONDS || 60) * 1000;
const inventoryCache = new Map(); // normalizedTitle -> { expiresAt, result }

function getCached(key) {
  const entry = inventoryCache.get(key);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.result;
}
function setCached(key, result) {
  inventoryCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result });
}

// Given a Map of fragranceProductId -> active mapping row, makes ONE real Odoo call for all of
// their SKUs at once (the endpoint genuinely supports this — confirmed via a real multi-SKU curl
// request) and returns a Map of fragranceProductId -> normalized inventory result.
async function resolveMappingsToInventory(mappingsByFragranceProductId) {
  const checkedAt = new Date().toISOString();
  const mappingEntries = [...mappingsByFragranceProductId.entries()];
  const skus = mappingEntries.map(([, mapping]) => mapping.odooSku);
  const response = await getInventoryBySkus(skus);
  const resultsByFragranceProductId = new Map();

  if (!response.ok || !response.json?.success) {
    for (const [fragranceProductId, mapping] of mappingEntries) {
      resultsByFragranceProductId.set(fragranceProductId, {
        fragranceProductId, odooSku: mapping.odooSku, found: false, availableOilMl: null, unit: null,
        mappingStatus: "LOOKUP_FAILED", checkedAt, raw: response,
      });
    }
    return resultsByFragranceProductId;
  }

  const productsBySku = new Map((response.json.products || []).map((p) => [p.default_code, p]));
  for (const [fragranceProductId, mapping] of mappingEntries) {
    const product = productsBySku.get(mapping.odooSku);
    if (!product) {
      resultsByFragranceProductId.set(fragranceProductId, {
        fragranceProductId, odooSku: mapping.odooSku, found: false, availableOilMl: null, unit: null,
        mappingStatus: "SKU_NOT_FOUND", checkedAt, raw: null,
      });
      continue;
    }
    resultsByFragranceProductId.set(fragranceProductId, {
      fragranceProductId, odooSku: mapping.odooSku, found: true,
      availableOilMl: typeof product.on_hand_qty === "number" ? product.on_hand_qty : null,
      unit: "ml", // assumed — the real API returns no UoM field, see module comment
      odooProductId: null, name: product.name ?? null,
      mappingStatus: "CONNECTED", checkedAt, raw: product,
    });
  }
  return resultsByFragranceProductId;
}

/**
 * Looks up the real, approved SKU mapping for one DUA product, then reads and normalizes its
 * current Odoo oil inventory. Never falls back to fuzzy name matching — a missing mapping is
 * reported as such, not guessed around. Bypasses the cache — intended for a deliberate single fresh
 * check (e.g. Save Build/Add to Cart, once wired), not for ranking many candidates.
 * @param {string} fragranceProductId
 */
export async function getOilInventoryForProduct(fragranceProductId) {
  const checkedAt = new Date().toISOString();
  const mapping = await prisma.odooOilMapping.findUnique({ where: { fragranceProductId } });
  if (!mapping || !mapping.active) {
    return { fragranceProductId, odooSku: null, found: false, availableOilMl: null, unit: null, mappingStatus: "MISSING", checkedAt };
  }
  const resolved = await resolveMappingsToInventory(new Map([[fragranceProductId, mapping]]));
  return resolved.get(fragranceProductId);
}

// The recommendation engine's candidates/combinations carry a real product TITLE, never a
// FragranceProduct.id — matching normalizedTitle is how everything else in this engine already
// resolves a real catalog row. Never fuzzy — exact normalizedTitle match only, same discipline as
// the SKU import script. Cached (see above).
export async function getOilInventoryForProductTitle(productTitle) {
  const results = await getOilInventoryForProductTitles([productTitle]);
  return results.results.get(productTitle);
}

/**
 * Batch-shaped entry point for checking one candidate's 2-4 real components at once — the ONE
 * function recommendation logic should call. Confirmed against the real endpoint: this makes AT
 * MOST one genuine Odoo HTTP request total (all uncached, mapped SKUs joined into one call) —
 * never one request per component. Deduplicates repeated titles within one candidate and reports
 * exactly how many real (non-cached, mapped) Odoo requests this call made, so the caller can
 * measure and report real request counts.
 * @param {string[]} productTitles
 * @returns {Promise<{results: Map<string, object>, requestCount: number, skusQueried: string[]}>}
 */
export async function getOilInventoryForProductTitles(productTitles) {
  const uniqueTitles = [...new Set(productTitles)];
  const results = new Map();
  const needsLookup = []; // { title, key, fragranceProductId, mapping }

  for (const title of uniqueTitles) {
    const key = normalizeProductName(title);
    const cached = getCached(key);
    if (cached) { results.set(title, cached); continue; }

    const checkedAt = new Date().toISOString();
    const product = await prisma.fragranceProduct.findFirst({ where: { normalizedTitle: key }, select: { id: true } });
    if (!product) {
      const result = { fragranceProductId: null, odooSku: null, found: false, availableOilMl: null, unit: null, mappingStatus: "MISSING", checkedAt };
      setCached(key, result);
      results.set(title, result);
      continue;
    }

    const mapping = await prisma.odooOilMapping.findUnique({ where: { fragranceProductId: product.id } });
    if (!mapping || !mapping.active) {
      const result = { fragranceProductId: product.id, odooSku: null, found: false, availableOilMl: null, unit: null, mappingStatus: "MISSING", checkedAt };
      setCached(key, result);
      results.set(title, result);
      continue;
    }

    needsLookup.push({ title, key, fragranceProductId: product.id, mapping });
  }

  const skusQueried = needsLookup.map((n) => n.mapping.odooSku);
  if (needsLookup.length) {
    const mappingsByFragranceProductId = new Map(needsLookup.map((n) => [n.fragranceProductId, n.mapping]));
    const resolved = await resolveMappingsToInventory(mappingsByFragranceProductId); // ONE real call
    for (const n of needsLookup) {
      const result = resolved.get(n.fragranceProductId);
      setCached(n.key, result);
      results.set(n.title, result);
    }
  }

  return { results, requestCount: needsLookup.length ? 1 : 0, skusQueried };
}

// Test-only escape hatch — without this, two tests checking the same real product title within the
// same TTL window would leak one test's cached Odoo response into the next.
export function __clearOdooInventoryCacheForTesting() {
  inventoryCache.clear();
}
