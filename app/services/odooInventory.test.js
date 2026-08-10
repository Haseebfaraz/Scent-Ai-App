// Integration tests against the real dev database (OdooOilMapping) with global.fetch mocked for the
// actual Odoo HTTP call — same convention as app/tools/fragranceAgentTools.season.test.js.
import { describe, it, expect, afterEach, vi } from "vitest";
import prisma from "../db.server.js";
import { getOilInventoryForProduct, classifyStockStatus } from "./odooInventory.server.js";

const originalFetch = global.fetch;
const createdMappingIds = [];

afterEach(async () => {
  if (createdMappingIds.length) {
    await prisma.odooOilMapping.deleteMany({ where: { id: { in: createdMappingIds } } });
    createdMappingIds.length = 0;
  }
  global.fetch = originalFetch;
});

async function createMapping(overrides = {}) {
  const row = await prisma.odooOilMapping.create({
    data: {
      fragranceProductId: `vitest-odoo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      odooSku: "OIL-VITEST-SKU",
      active: true,
      ...overrides,
    },
  });
  createdMappingIds.push(row.id);
  return row;
}

function mockOdooJson(json, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({ ok: status < 400, status, text: async () => JSON.stringify(json) });
}

describe("getOilInventoryForProduct", () => {
  it("MISSING when no mapping row exists for this product", async () => {
    const result = await getOilInventoryForProduct("vitest-no-mapping-" + Date.now());
    expect(result.mappingStatus).toBe("MISSING");
    expect(result.found).toBe(false);
  });

  it("MISSING when the mapping row exists but is inactive", async () => {
    const mapping = await createMapping({ active: false });
    const result = await getOilInventoryForProduct(mapping.fragranceProductId);
    expect(result.mappingStatus).toBe("MISSING");
  });

  it("CONNECTED, with available (not raw on-hand) used as availableOilMl — reserved stock is never counted as available", async () => {
    const mapping = await createMapping();
    mockOdooJson({ ok: true, result: { sku: "OIL-VITEST-SKU", found: true, unit: "ml", onHand: 500, reserved: 100, available: 400, name: "Vitest Oil" } });

    const result = await getOilInventoryForProduct(mapping.fragranceProductId);
    expect(result.mappingStatus).toBe("CONNECTED");
    expect(result.availableOilMl).toBe(400);
    expect(result.odooSku).toBe("OIL-VITEST-SKU");
  });

  it("converts liters to ml (1 L = 1000 ml)", async () => {
    const mapping = await createMapping();
    mockOdooJson({ result: { found: true, unit: "L", available: 0.4 } });
    const result = await getOilInventoryForProduct(mapping.fragranceProductId);
    expect(result.availableOilMl).toBe(400);
  });

  it("SKU_NOT_FOUND when Odoo reports the SKU doesn't exist", async () => {
    const mapping = await createMapping();
    mockOdooJson({ result: { sku: "OIL-VITEST-SKU", found: false } });
    const result = await getOilInventoryForProduct(mapping.fragranceProductId);
    expect(result.mappingStatus).toBe("SKU_NOT_FOUND");
  });

  it("UNSUPPORTED_UOM for an unrecognized/ambiguous unit — never guesses a conversion", async () => {
    const mapping = await createMapping();
    mockOdooJson({ result: { found: true, unit: "kg", available: 5 } });
    const result = await getOilInventoryForProduct(mapping.fragranceProductId);
    expect(result.mappingStatus).toBe("UNSUPPORTED_UOM");
    expect(result.availableOilMl).toBe(null);
  });

  it("LOOKUP_FAILED when Odoo is unreachable or returns a non-JSON error page", async () => {
    const mapping = await createMapping();
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await getOilInventoryForProduct(mapping.fragranceProductId);
    expect(result.mappingStatus).toBe("LOOKUP_FAILED");
  });

  it("LOOKUP_FAILED for a malformed/non-JSON response (e.g. an HTML 404 page)", async () => {
    const mapping = await createMapping();
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "<html>Not Found</html>" });
    const result = await getOilInventoryForProduct(mapping.fragranceProductId);
    expect(result.mappingStatus).toBe("LOOKUP_FAILED");
  });
});

describe("classifyStockStatus (buildable-bottle-count thresholds, not raw ml)", () => {
  it("21+ bottles -> IN_STOCK", () => expect(classifyStockStatus(21)).toBe("IN_STOCK"));
  it("6-20 bottles -> LOW_STOCK", () => expect(classifyStockStatus(6)).toBe("LOW_STOCK"));
  it("1-5 bottles -> CRITICAL", () => expect(classifyStockStatus(1)).toBe("CRITICAL"));
  it("0 bottles -> OUT_OF_STOCK", () => expect(classifyStockStatus(0)).toBe("OUT_OF_STOCK"));
  it("unknown -> UNKNOWN", () => expect(classifyStockStatus(null)).toBe("UNKNOWN"));
});
