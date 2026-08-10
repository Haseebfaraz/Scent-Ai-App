// Normalizes raw Odoo API responses into ml and a stock status, and resolves the DUA product ->
// Odoo SKU mapping — hides both from recommendation logic, which should only ever see clean
// { availableOilMl, stockStatus, ... } facts, never a raw HTTP/JSON shape or a bare mapping row.
import prisma from "../db.server.js";
import { getInventoryBySku } from "./odooClient.server.js";

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

/**
 * Looks up the real, approved SKU mapping for one DUA product, then reads and normalizes its
 * current Odoo oil inventory. Never falls back to fuzzy name matching — a missing mapping is
 * reported as such, not guessed around.
 * @param {string} fragranceProductId
 * @returns {Promise<{fragranceProductId: string, odooSku: string|null, found: boolean, availableOilMl: number|null, unit: string|null, mappingStatus: "MISSING"|"CONNECTED"|"SKU_NOT_FOUND"|"UNSUPPORTED_UOM"|"LOOKUP_FAILED", checkedAt: string, raw?: object}>}
 */
export async function getOilInventoryForProduct(fragranceProductId) {
  const checkedAt = new Date().toISOString();
  const mapping = await prisma.odooOilMapping.findUnique({ where: { fragranceProductId } });

  if (!mapping || !mapping.active) {
    return { fragranceProductId, odooSku: null, found: false, availableOilMl: null, unit: null, mappingStatus: "MISSING", checkedAt };
  }

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

export { SUPPORTED_UNITS };
