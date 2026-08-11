// Normalizes raw Odoo API responses into ml and a stock status, and resolves the DUA product ->
// Odoo SKU mapping — hides both from recommendation logic, which should only ever see clean
// { availableOilMl, stockStatus, ... } facts, never a raw HTTP/JSON shape or a bare mapping row.
import prisma from "../db.server.js";
import { getInventoryBySku } from "./odooClient.server.js";
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

// 1 L = 1000 ml is the only unit conversion this ever performs automatically. Mass units (g/kg)
// are never converted to volume without an approved density rule — unsupported/ambiguous units
// become UNKNOWN and must be rejected in STRICT mode by the caller, never guessed.
const SUPPORTED_UNITS = new Set(["ml", "l"]);
function toMl(quantity, unit) {
  const normalizedUnit = String(unit || "").trim().toLowerCase();
  if (normalizedUnit === "ml") return quantity;
  if (normalizedUnit === "l") return quantity * 1000;
  return null;
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

// Given an already-resolved, active mapping row, calls Odoo and normalizes the answer. The ONLY
// function in this file that actually performs a network call — isolated here so request-counting
// (getOilInventoryForProductTitles) and the single-product path (getOilInventoryForProduct) share
// one implementation instead of two copies that could drift.
async function resolveMappingToInventory(fragranceProductId, mapping, checkedAt) {
  const response = await getInventoryBySku(mapping.odooSku);
  if (!response.ok || !response.json) {
    return {
      fragranceProductId, odooSku: mapping.odooSku, found: false, availableOilMl: null, unit: null,
      mappingStatus: "LOOKUP_FAILED", checkedAt, raw: response,
    };
  }

  const result = response.json.result || response.json;
  if (!result || result.found === false) {
    return { fragranceProductId, odooSku: mapping.odooSku, found: false, availableOilMl: null, unit: null, mappingStatus: "SKU_NOT_FOUND", checkedAt, raw: result };
  }

  // available/free-to-use only — reserved stock is never treated as available, per spec.
  const rawAvailable = typeof result.available === "number" ? result.available : (result.onHand || 0) - (result.reserved || 0);
  const availableOilMl = toMl(rawAvailable, result.unit);
  if (availableOilMl == null) {
    return { fragranceProductId, odooSku: mapping.odooSku, found: true, availableOilMl: null, unit: result.unit ?? null, mappingStatus: "UNSUPPORTED_UOM", checkedAt, raw: result };
  }

  return {
    fragranceProductId, odooSku: mapping.odooSku, found: true, availableOilMl, unit: result.unit,
    odooProductId: result.odooProductId ?? null, name: result.name ?? null,
    mappingStatus: "CONNECTED", checkedAt, raw: result,
  };
}

/**
 * Looks up the real, approved SKU mapping for one DUA product, then reads and normalizes its
 * current Odoo oil inventory. Never falls back to fuzzy name matching — a missing mapping is
 * reported as such, not guessed around. Bypasses the cache — intended for a deliberate single fresh
 * check (e.g. Save Build/Add to Cart, once wired), not for ranking many candidates.
 * @param {string} fragranceProductId
 * @returns {Promise<{fragranceProductId: string, odooSku: string|null, found: boolean, availableOilMl: number|null, unit: string|null, mappingStatus: "MISSING"|"CONNECTED"|"SKU_NOT_FOUND"|"UNSUPPORTED_UOM"|"LOOKUP_FAILED", checkedAt: string, raw?: object}>}
 */
export async function getOilInventoryForProduct(fragranceProductId) {
  const checkedAt = new Date().toISOString();
  const mapping = await prisma.odooOilMapping.findUnique({ where: { fragranceProductId } });
  if (!mapping || !mapping.active) {
    return { fragranceProductId, odooSku: null, found: false, availableOilMl: null, unit: null, mappingStatus: "MISSING", checkedAt };
  }
  return resolveMappingToInventory(fragranceProductId, mapping, checkedAt);
}

// The recommendation engine's candidates/combinations carry a real product TITLE, never a
// FragranceProduct.id — matching normalizedTitle is how everything else in this engine already
// resolves a real catalog row. Never fuzzy — exact normalizedTitle match only, same discipline as
// the SKU import script. Cached (see above).
export async function getOilInventoryForProductTitle(productTitle) {
  const key = normalizeProductName(productTitle);
  const cached = getCached(key);
  if (cached) return cached;

  const checkedAt = new Date().toISOString();
  const product = await prisma.fragranceProduct.findFirst({ where: { normalizedTitle: key }, select: { id: true } });
  const result = product
    ? await getOilInventoryForProduct(product.id)
    : { fragranceProductId: null, odooSku: null, found: false, availableOilMl: null, unit: null, mappingStatus: "MISSING", checkedAt };

  setCached(key, result);
  return result;
}

/**
 * Batch-shaped entry point for checking one candidate's 2-4 real components at once — the ONE
 * function recommendation logic should call. Today this fans out with Promise.all against the
 * confirmed GET /inventory?sku= contract (each call still individually capped by odooClient's own
 * request timeout); if the Odoo side later adds POST /inventory/batch, only this function's
 * internals change — no caller needs to know or care. Deduplicates repeated titles within one
 * candidate and reports exactly how many real (non-cached, mapped) Odoo requests this call made, so
 * the caller can measure and report real request counts.
 * @param {string[]} productTitles
 * @returns {Promise<{results: Map<string, object>, requestCount: number, skusQueried: string[]}>}
 */
export async function getOilInventoryForProductTitles(productTitles) {
  const uniqueTitles = [...new Set(productTitles)];
  const results = new Map();
  const skusQueried = [];
  let requestCount = 0;

  await Promise.all(uniqueTitles.map(async (title) => {
    const key = normalizeProductName(title);
    const cached = getCached(key);
    if (cached) { results.set(title, cached); return; }

    const checkedAt = new Date().toISOString();
    const product = await prisma.fragranceProduct.findFirst({ where: { normalizedTitle: key }, select: { id: true } });
    if (!product) {
      const result = { fragranceProductId: null, odooSku: null, found: false, availableOilMl: null, unit: null, mappingStatus: "MISSING", checkedAt };
      setCached(key, result);
      results.set(title, result);
      return;
    }

    const mapping = await prisma.odooOilMapping.findUnique({ where: { fragranceProductId: product.id } });
    if (!mapping || !mapping.active) {
      const result = { fragranceProductId: product.id, odooSku: null, found: false, availableOilMl: null, unit: null, mappingStatus: "MISSING", checkedAt };
      setCached(key, result);
      results.set(title, result);
      return;
    }

    requestCount += 1;
    skusQueried.push(mapping.odooSku);
    const result = await resolveMappingToInventory(product.id, mapping, checkedAt);
    setCached(key, result);
    results.set(title, result);
  }));

  return { results, requestCount, skusQueried };
}

// Test-only escape hatch — without this, two tests checking the same real product title within the
// same TTL window would leak one test's cached Odoo response into the next.
export function __clearOdooInventoryCacheForTesting() {
  inventoryCache.clear();
}

export { SUPPORTED_UNITS };
