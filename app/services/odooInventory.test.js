// Integration tests against the real dev database (OdooOilMapping) with global.fetch mocked for the
// actual Odoo HTTP call — same convention as app/tools/fragranceAgentTools.season.test.js.
// Mocked response shape matches the REAL confirmed endpoint (2026-08-11):
//   { "success": true, "products": [{ "name": "...", "default_code": "SKU", "on_hand_qty": 0.0 }] }
// No reserved/available split and no UoM field exist on the real API — see odooInventory.server.js's
// module comment for how those two real limitations are handled.
import { describe, it, expect, afterEach, vi } from "vitest";
import prisma from "../db.server.js";
import { getOilInventoryForProduct, getOilInventoryForProductTitles, classifyStockStatus, __clearOdooInventoryCacheForTesting } from "./odooInventory.server.js";

const originalFetch = global.fetch;
const createdMappingIds = [];

afterEach(async () => {
  if (createdMappingIds.length) {
    await prisma.odooOilMapping.deleteMany({ where: { id: { in: createdMappingIds } } });
    createdMappingIds.length = 0;
  }
  global.fetch = originalFetch;
  __clearOdooInventoryCacheForTesting();
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

function mockOdooProducts(products, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({ ok: status < 400, status, text: async () => JSON.stringify({ success: true, products }) });
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

  it("CONNECTED, using on_hand_qty as availableOilMl (the real API exposes no reserved/available split)", async () => {
    const mapping = await createMapping();
    mockOdooProducts([{ name: "Vitest Oil", default_code: "OIL-VITEST-SKU", on_hand_qty: 400 }]);

    const result = await getOilInventoryForProduct(mapping.fragranceProductId);
    expect(result.mappingStatus).toBe("CONNECTED");
    expect(result.availableOilMl).toBe(400);
    expect(result.odooSku).toBe("OIL-VITEST-SKU");
  });

  it("SKU_NOT_FOUND when the requested SKU isn't present in the returned products array", async () => {
    const mapping = await createMapping();
    mockOdooProducts([{ name: "Some Other Oil", default_code: "OIL-SOMETHING-ELSE", on_hand_qty: 10 }]);
    const result = await getOilInventoryForProduct(mapping.fragranceProductId);
    expect(result.mappingStatus).toBe("SKU_NOT_FOUND");
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

  it("LOOKUP_FAILED when the response is ok but success is not true", async () => {
    const mapping = await createMapping();
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ success: false }) });
    const result = await getOilInventoryForProduct(mapping.fragranceProductId);
    expect(result.mappingStatus).toBe("LOOKUP_FAILED");
  });
});

describe("getOilInventoryForProductTitles — real batching", () => {
  // "The Opera" / "Water of Arabia" already carry real mappings from the catalog import — save and
  // restore the original row (never a blind create/delete) so this test can never corrupt real
  // seeded data. createMapping() above assumes a fresh synthetic id and would collide on the
  // existing row's unique fragranceProductId constraint.
  const savedOriginals = [];
  afterEach(async () => {
    for (const { fragranceProductId, original } of savedOriginals) {
      if (original) {
        await prisma.odooOilMapping.update({ where: { fragranceProductId }, data: { odooSku: original.odooSku, active: original.active } });
      } else {
        await prisma.odooOilMapping.deleteMany({ where: { fragranceProductId } });
      }
    }
    savedOriginals.length = 0;
  });
  async function mapRealProductTemporarily(title, sku) {
    const product = await prisma.fragranceProduct.findFirst({ where: { title }, select: { id: true } });
    const original = await prisma.odooOilMapping.findUnique({ where: { fragranceProductId: product.id } });
    savedOriginals.push({ fragranceProductId: product.id, original });
    await prisma.odooOilMapping.upsert({
      where: { fragranceProductId: product.id },
      create: { fragranceProductId: product.id, odooSku: sku, active: true },
      update: { odooSku: sku, active: true },
    });
    return product;
  }

  // Fix (cross-file test race) — confirmed live: fragranceAgentTools.autoConfirmConfidence.test.js
  // ALSO temporarily remaps "The Opera"/"Water of Arabia", and vitest runs test files concurrently,
  // so that file's afterEach restore landed mid-test here and clobbered this test's own value.
  // Deliberately different real products from every other file that does this same pattern.
  it("makes exactly one real Odoo request for multiple mapped components, matching each by default_code", async () => {
    await mapRealProductTemporarily("Arabian Amber Nuit", "OIL-VITEST-AMBER");
    await mapRealProductTemporarily("Iris Cafe", "OIL-VITEST-IRISCAFE");
    mockOdooProducts([
      { name: "Arabian Amber Nuit - Oil", default_code: "OIL-VITEST-AMBER", on_hand_qty: 1830 },
      { name: "Iris Cafe - Oil", default_code: "OIL-VITEST-IRISCAFE", on_hand_qty: 0 },
    ]);

    const { results, requestCount, skusQueried } = await getOilInventoryForProductTitles(["Arabian Amber Nuit", "Iris Cafe"]);
    expect(requestCount).toBe(1);
    expect(skusQueried.sort()).toEqual(["OIL-VITEST-AMBER", "OIL-VITEST-IRISCAFE"]);
    expect(results.get("Arabian Amber Nuit").availableOilMl).toBe(1830);
    expect(results.get("Iris Cafe").availableOilMl).toBe(0);
  });

  it("makes zero requests when nothing needs a real lookup (all MISSING/cached)", async () => {
    global.fetch = vi.fn(); // would fail the test if actually called
    const { requestCount } = await getOilInventoryForProductTitles(["Definitely Not A Real Product " + Date.now()]);
    expect(requestCount).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("classifyStockStatus (buildable-bottle-count thresholds, not raw ml)", () => {
  it("21+ bottles -> IN_STOCK", () => expect(classifyStockStatus(21)).toBe("IN_STOCK"));
  it("6-20 bottles -> LOW_STOCK", () => expect(classifyStockStatus(6)).toBe("LOW_STOCK"));
  it("1-5 bottles -> CRITICAL", () => expect(classifyStockStatus(1)).toBe("CRITICAL"));
  it("0 bottles -> OUT_OF_STOCK", () => expect(classifyStockStatus(0)).toBe("OUT_OF_STOCK"));
  it("unknown -> UNKNOWN", () => expect(classifyStockStatus(null)).toBe("UNKNOWN"));
});
