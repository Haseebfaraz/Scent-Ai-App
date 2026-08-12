// Persistence correctness for the historical Odoo-feasibility snapshot — real DB, no mocking of
// prisma itself (same convention as odooInventory.test.js/fragranceAgentTools tests in this repo).
import { describe, it, expect, afterEach, vi } from "vitest";
import prisma from "../db.server.js";
import { saveInventorySnapshot, getInventorySnapshot } from "./recommendationInventorySnapshot.server.js";
import { saveRecommendation } from "./recommendationConfirmation.server.js";
import { __evaluateCandidateInventoryForTesting as evaluateInventory } from "../tools/fragranceAgentTools.server.js";
import { __clearOdooInventoryCacheForTesting } from "./odooInventory.server.js";

const REAL_PAIR = { first: { title: "The Opera", notes: ["Rose", "Fruity Notes", "Ambergris", "Leather", "Nutmeg", "Cedar", "Vanilla", "Musk"] }, second: { title: "Water of Arabia", notes: ["Mandarin", "Bergamot", "Blackcurrant", "Green Tea", "Sandalwood"] } };
function realCombo() {
  return {
    type: "HYBRID",
    internalProducts: [
      { title: REAL_PAIR.first.title, contribution: "Freshness", notes: REAL_PAIR.first.notes },
      { title: REAL_PAIR.second.title, contribution: "Sweetness", notes: REAL_PAIR.second.notes },
    ],
    recommendedRatio: [
      { productTitle: REAL_PAIR.first.title, ratioPercent: 50 },
      { productTitle: REAL_PAIR.second.title, ratioPercent: 50 },
    ],
    customerFacingName: "The Opera x Water of Arabia",
  };
}

function freshConversationId(label) {
  return `vitest-invsnap-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function makeRecommendation(label) {
  const conversationId = freshConversationId(label);
  const id = await saveRecommendation({
    conversationId,
    profile: { likes: [], dislikes: [] },
    combination: realCombo(),
  });
  return { conversationId, id };
}

const createdRecommendationIds = [];
afterEach(async () => {
  if (createdRecommendationIds.length) {
    await prisma.fragranceRecommendation.deleteMany({ where: { id: { in: createdRecommendationIds } } });
    createdRecommendationIds.length = 0;
  }
});

describe("saveInventorySnapshot / getInventorySnapshot — pure persistence", () => {
  it("persists parent + component fields exactly as given, and reads them back unchanged", async () => {
    const { id: recommendationId } = await makeRecommendation("basic");
    createdRecommendationIds.push(recommendationId);

    const checkedAt = new Date().toISOString();
    await saveInventorySnapshot({
      recommendationId,
      inventoryValidated: true,
      buildable: true,
      checkedAt,
      oilTotalMl: 13,
      alcoholMl: 21,
      requestStatus: "ok",
      maxBuildableBottles: 42,
      limitingSku: "DUA-OPERA_Oil",
      components: [
        {
          fragranceProductId: "fp-1", productTitle: "The Opera", odooSku: "DUA-OPERA_Oil",
          ratioPercent: 50, requiredOilMl: 6.5, onHandQty: 300, mappingStatus: "CONNECTED",
          sufficient: true, maxBuildableBottlesForComponent: 46,
        },
        {
          fragranceProductId: null, productTitle: "Water of Arabia", odooSku: null,
          ratioPercent: 50, requiredOilMl: 6.5, onHandQty: null, mappingStatus: "MISSING",
          sufficient: null, maxBuildableBottlesForComponent: null,
        },
      ],
    });

    const snapshot = await getInventorySnapshot(recommendationId);
    expect(snapshot.inventoryValidated).toBe(true);
    expect(snapshot.buildable).toBe(true);
    expect(snapshot.oilTotalMl).toBe(13);
    expect(snapshot.alcoholMl).toBe(21);
    expect(snapshot.maxBuildableBottles).toBe(42);
    expect(snapshot.limitingSku).toBe("DUA-OPERA_Oil");
    expect(snapshot.requestStatus).toBe("ok");
    expect(snapshot.components).toHaveLength(2);

    const opera = snapshot.components.find((c) => c.productTitle === "The Opera");
    expect(opera.odooSku).toBe("DUA-OPERA_Oil");
    expect(opera.requiredOilMl).toBe(6.5);
    expect(opera.onHandQty).toBe(300);
    expect(opera.sufficient).toBe(true);
    expect(opera.maxBuildableBottlesForComponent).toBe(46);

    const water = snapshot.components.find((c) => c.productTitle === "Water of Arabia");
    expect(water.mappingStatus).toBe("MISSING");
    expect(water.sufficient).toBeNull();
    expect(water.onHandQty).toBeNull();
  });

  it("never persists a secret, even if a buggy caller's component carries an extra raw field containing one", async () => {
    const { id: recommendationId } = await makeRecommendation("secret-guard");
    createdRecommendationIds.push(recommendationId);

    await saveInventorySnapshot({
      recommendationId,
      inventoryValidated: false,
      buildable: true,
      checkedAt: new Date().toISOString(),
      oilTotalMl: 13,
      alcoholMl: 21,
      requestStatus: "ok",
      maxBuildableBottles: null,
      limitingSku: null,
      components: [
        {
          fragranceProductId: null, productTitle: "The Opera", odooSku: "DUA-OPERA_Oil",
          ratioPercent: 50, requiredOilMl: 6.5, onHandQty: null, mappingStatus: "LOOKUP_FAILED",
          sufficient: null, maxBuildableBottlesForComponent: null,
          // Not a declared field on RecommendationInventoryComponent — Prisma's create() only ever
          // writes the columns it's explicitly given below, so this must never land in the DB.
          _rawOdooRequest: { headers: { Authorization: "Bearer f4f0ba800d6e298a616c5dfb25f2f4876957f75a" } },
        },
      ],
    });

    const snapshot = await getInventorySnapshot(recommendationId);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toMatch(/Bearer/i);
    expect(serialized).not.toMatch(/Authorization/i);
    expect(serialized).not.toMatch(/f4f0ba800d6e298a616c5dfb25f2f4876957f75a/);
  });

  it("enforces one snapshot per recommendation — a second save for the same recommendationId is rejected, never silently overwritten", async () => {
    const { id: recommendationId } = await makeRecommendation("immutable");
    createdRecommendationIds.push(recommendationId);
    const args = {
      recommendationId, inventoryValidated: true, buildable: true, checkedAt: new Date().toISOString(),
      oilTotalMl: 13, alcoholMl: 21, requestStatus: "ok", maxBuildableBottles: 10, limitingSku: null,
      components: [],
    };
    await saveInventorySnapshot(args);
    await expect(saveInventorySnapshot({ ...args, oilTotalMl: 999 })).rejects.toThrow();

    // The original historical value survives untouched — never silently rewritten by the rejected
    // second attempt (point 3 of the spec: a later Odoo state change must never backfill this row).
    const snapshot = await getInventorySnapshot(recommendationId);
    expect(snapshot.oilTotalMl).toBe(13);
  });

  it("getInventorySnapshot returns null for a recommendation that was never checked against Odoo", async () => {
    const { id: recommendationId } = await makeRecommendation("no-snapshot");
    createdRecommendationIds.push(recommendationId);
    expect(await getInventorySnapshot(recommendationId)).toBeNull();
  });
});

// Proves the "compute once, persist verbatim" guarantee end to end: evaluateCandidateInventory's
// real output feeds saveInventorySnapshot unmodified, so the persisted row can never drift from
// what was actually logged/decided at selection time.
describe("evaluateCandidateInventory -> saveInventorySnapshot integration", () => {
  const originalFetch = global.fetch;
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
    global.fetch = originalFetch;
    __clearOdooInventoryCacheForTesting();
  });

  async function mapRealProduct(title, sku) {
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

  // Deliberately different real products from every other file/describe block that also
  // temporarily remaps an OdooOilMapping row ("The Opera"/"Water of Arabia" and "Arabian Amber
  // Nuit"/"Iris Cafe" are already used elsewhere) — vitest runs test files concurrently, and a
  // shared row's afterEach restore landing mid-test in another file is a real, previously-hit race.
  it("persists the exact requiredOilMl/onHandQty/sufficient/maxBuildableBottles values evaluateCandidateInventory computed", async () => {
    await mapRealProduct("Leather Oud", "OIL-VITEST-SNAP-LEATHEROUD");
    await mapRealProduct("Minty Fresh", "OIL-VITEST-SNAP-MINTYFRESH");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        success: true,
        products: [
          { name: "Leather Oud - Oil", default_code: "OIL-VITEST-SNAP-LEATHEROUD", on_hand_qty: 300 },
          { name: "Minty Fresh - Oil", default_code: "OIL-VITEST-SNAP-MINTYFRESH", on_hand_qty: 2 },
        ],
      }),
    });

    const { id: recommendationId } = await makeRecommendation("integration");
    createdRecommendationIds.push(recommendationId);

    const candidate = {
      recommendationId,
      recommendedRatio: [
        { productTitle: "Leather Oud", ratioPercent: 50 },
        { productTitle: "Minty Fresh", ratioPercent: 50 },
      ],
    };
    const inventory = await evaluateInventory(candidate);
    await saveInventorySnapshot({
      recommendationId,
      inventoryValidated: inventory.inventoryValidated,
      buildable: inventory.buildable,
      checkedAt: new Date().toISOString(),
      oilTotalMl: inventory.oilTotalMl,
      alcoholMl: inventory.alcoholMl,
      requestStatus: inventory.status,
      maxBuildableBottles: inventory.maxBuildableBottles,
      limitingSku: inventory.limitingSku,
      components: inventory.components,
    });

    const snapshot = await getInventorySnapshot(recommendationId);
    expect(snapshot.buildable).toBe(inventory.buildable);
    expect(snapshot.buildable).toBe(false); // Minty Fresh only has 2ml, needs 6.5ml
    expect(snapshot.maxBuildableBottles).toBe(inventory.maxBuildableBottles);
    expect(snapshot.limitingSku).toBe("OIL-VITEST-SNAP-MINTYFRESH");

    const water = snapshot.components.find((c) => c.odooSku === "OIL-VITEST-SNAP-MINTYFRESH");
    expect(water.onHandQty).toBe(2);
    expect(water.requiredOilMl).toBeCloseTo(6.5);
    expect(water.sufficient).toBe(false);
  });

  // Point 1/14 of the spec: real SKUs/ratios/required-ml are useful and explicitly approved for
  // logging; the Authorization header/Bearer token/API key must never appear in either log line.
  it("ODOO_INVENTORY_REQUEST/RESPONSE logs carry the real SKU/ratio/requiredOilMl but never the Authorization header or API key", async () => {
    const originalApiKey = process.env.ODOO_INVENTORY_API_KEY;
    process.env.ODOO_INVENTORY_API_KEY = "vitest-fake-secret-token-should-never-be-logged";
    await mapRealProduct("Leather Oud", "OIL-VITEST-LOG-LEATHEROUD");
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ success: true, products: [{ name: "Leather Oud - Oil", default_code: "OIL-VITEST-LOG-LEATHEROUD", on_hand_qty: 300 }] }),
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { id: recommendationId } = await makeRecommendation("logging");
      createdRecommendationIds.push(recommendationId);
      await evaluateInventory({
        recommendationId,
        recommendedRatio: [{ productTitle: "Leather Oud", ratioPercent: 50 }, { productTitle: "Minty Fresh", ratioPercent: 50 }],
      });

      const requestLog = logSpy.mock.calls.find(([label]) => label === "ODOO_INVENTORY_REQUEST");
      const responseLog = logSpy.mock.calls.find(([label]) => label === "ODOO_INVENTORY_RESPONSE");
      expect(requestLog).toBeTruthy();
      expect(responseLog).toBeTruthy();

      const requestSerialized = JSON.stringify(requestLog[1]);
      const responseSerialized = JSON.stringify(responseLog[1]);
      expect(requestSerialized).toContain("OIL-VITEST-LOG-LEATHEROUD");
      expect(requestSerialized).toContain("\"ratioPercent\":50");
      expect(requestSerialized).toMatch(/requiredOilMl/);

      for (const serialized of [requestSerialized, responseSerialized]) {
        expect(serialized).not.toMatch(/Bearer/i);
        expect(serialized).not.toMatch(/Authorization/i);
        expect(serialized).not.toMatch(/API_KEY/i);
        expect(serialized).not.toContain("vitest-fake-secret-token-should-never-be-logged");
      }
    } finally {
      logSpy.mockRestore();
      process.env.ODOO_INVENTORY_API_KEY = originalApiKey;
    }
  });
});
