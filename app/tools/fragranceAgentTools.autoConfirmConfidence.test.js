// Fix (Phase 15 — no confidence gate before auto-confirmation) — confirmed as a real gap: the
// highest-ranked candidate got auto-confirmed regardless of confidence, so a "low" confidence
// combination (thin data, poor customer fit, or a real compatibility risk) could be presented to
// the customer with exactly the same certainty as a "very high" one.
//
// Fix (persist the gate's own reasoning) — evaluateAutoConfirmEligibility(candidate, profile) is
// the ONE function that decides and explains auto-confirmation; these tests exercise it directly
// with synthetic candidates/profiles, no real generation needed. A hard-dislike conflict needs a
// profile (independent of the candidate's own scoring), so the test hook now takes both.
//
// Fix (30s+ generation turns) — Odoo manufacturing feasibility is a SEPARATE, later gate
// (evaluateCandidateInventory, its own describe block below) checked only for the one ranked
// candidate under consideration in autoSelectAndConfirmBest, never for every candidate up front.
// evaluateAutoConfirmEligibility itself stays fully deterministic/synchronous — no network call.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __evaluateAutoConfirmEligibilityForTesting as evaluate,
  __evaluateCandidateInventoryForTesting as evaluateInventory,
} from "./fragranceAgentTools.server.js";
import { CUSTOMER_FIT_LOW_THRESHOLD } from "../services/recommendationEngine.server.js";
import { __clearOdooInventoryCacheForTesting } from "../services/odooInventory.server.js";
import prisma from "../db.server.js";

function candidate(overrides = {}) {
  return {
    type: "HYBRID",
    internalProducts: [
      { title: "A", notes: ["Bergamot", "Lemon"], contribution: "Freshness" },
      { title: "B", notes: ["Vanilla", "Musk"], contribution: "Sweetness" },
    ],
    recommendedRatio: [
      { productTitle: "A", ratioPercent: 50 },
      { productTitle: "B", ratioPercent: 50 },
    ],
    confidenceBreakdown: { customerFit: { value: "high" }, compatibility: { value: "high" }, historical: { value: "low" }, data: { value: "low" }, novelty: { value: "low" } },
    riskBreakdown: [],
    ...overrides,
  };
}

describe("evaluateAutoConfirmEligibility (deterministic — no network call)", () => {
  it("auto-confirms strong customer fit with zero history (sparse evidence never blocks)", () => {
    const c = candidate({ confidenceBreakdown: { customerFit: { value: "high" }, compatibility: { value: "high" }, historical: { value: "low" } } });
    const result = evaluate(c, { dislikes: [] });
    expect(result.autoConfirmEligible).toBe(true);
    expect(result.autoConfirmReasons).toEqual([]);
  });

  it("does NOT auto-confirm weak customer fit even with excellent history (a poor match is a bad formula, not thin evidence)", () => {
    const c = candidate({ confidenceBreakdown: { customerFit: { value: "low" }, compatibility: { value: "high" }, historical: { value: "high" } } });
    const result = evaluate(c, { dislikes: [] });
    expect(result.autoConfirmEligible).toBe(false);
    expect(result.autoConfirmReasons).toContain("customer_fit_low");
  });

  it("does NOT auto-confirm good customer fit with poor compatibility", () => {
    const c = candidate({ confidenceBreakdown: { customerFit: { value: "high" }, compatibility: { value: "low" } } });
    const result = evaluate(c, { dislikes: [] });
    expect(result.autoConfirmEligible).toBe(false);
    expect(result.autoConfirmReasons).toContain("compatibility_low");
  });

  it("advisory/low risks do not block", () => {
    const c = candidate({
      confidenceBreakdown: { customerFit: { value: "high" }, compatibility: { value: "medium" } },
      riskBreakdown: [{ counted: true, severity: "advisory" }, { counted: true, severity: "low" }],
    });
    const result = evaluate(c, { dislikes: [] });
    expect(result.autoConfirmEligible).toBe(true);
    expect(result.highestCountedRiskSeverity).toBe("low");
  });

  it("high/critical risks do block", () => {
    const high = candidate({ riskBreakdown: [{ counted: true, severity: "high" }] });
    const highResult = evaluate(high, { dislikes: [] });
    expect(highResult.autoConfirmEligible).toBe(false);
    expect(highResult.autoConfirmReasons).toContain("high_severity_risk:high");

    const critical = candidate({ riskBreakdown: [{ counted: true, severity: "critical" }] });
    const criticalResult = evaluate(critical, { dislikes: [] });
    expect(criticalResult.autoConfirmEligible).toBe(false);
    expect(criticalResult.autoConfirmReasons).toContain("high_severity_risk:critical");
  });

  it("ignores a high-severity risk that was correlation-deduplicated out (counted: false)", () => {
    const c = candidate({ riskBreakdown: [{ counted: false, severity: "high" }] });
    const result = evaluate(c, { dislikes: [] });
    expect(result.autoConfirmEligible).toBe(true);
    expect(result.highestCountedRiskSeverity).toBe(null);
  });

  // A hard dislike is checked independently of the candidate's own score/confidence — it must
  // block even when everything else about the formula reads perfectly.
  it("a hard dislike always blocks, regardless of final score or history", () => {
    const c = candidate({
      internalProducts: [
        { title: "A", notes: ["Sandalwood", "Bergamot"], contribution: "Base" },
        { title: "B", notes: ["Vanilla"], contribution: "Sweetness" },
      ],
      confidenceBreakdown: { customerFit: { value: "high" }, compatibility: { value: "high" }, historical: { value: "high" } },
      riskBreakdown: [],
    });
    const result = evaluate(c, { dislikes: ["Sandalwood"] });
    expect(result.autoConfirmEligible).toBe(false);
    expect(result.autoConfirmReasons).toContain("hard_dislike_conflict");
    expect(result.hasHardDislikeConflict).toBe(true);
  });

  it("a stated family dislike (not a literal note) does not trip the hard-dislike check — that's the existing severity-scaled path", () => {
    const c = candidate({ confidenceBreakdown: { customerFit: { value: "high" }, compatibility: { value: "high" } } });
    const result = evaluate(c, { dislikes: ["Woody fragrances"] });
    expect(result.hasHardDislikeConflict).toBe(false);
  });

  it("blocks an invalid combination shape (ratios that don't sum to 100%) regardless of everything else", () => {
    const c = candidate({
      recommendedRatio: [{ productTitle: "A", ratioPercent: 40 }, { productTitle: "B", ratioPercent: 40 }],
      confidenceBreakdown: { customerFit: { value: "high" }, compatibility: { value: "high" } },
      riskBreakdown: [],
    });
    const result = evaluate(c, { dislikes: [] });
    expect(result.autoConfirmEligible).toBe(false);
    expect(result.autoConfirmReasons).toContain("invalid_shape");
    expect(result.shapeValid).toBe(false);
  });

  it("exposes the actual customer-fit threshold the gate compares against", () => {
    const result = evaluate(candidate(), { dislikes: [] });
    expect(result.customerFitThreshold).toBe(CUSTOMER_FIT_LOW_THRESHOLD);
  });

  it("reports the highest severity among counted risks, not just the first one", () => {
    const c = candidate({
      confidenceBreakdown: { customerFit: { value: "high" }, compatibility: { value: "medium" } },
      riskBreakdown: [{ counted: true, severity: "advisory" }, { counted: true, severity: "medium" }, { counted: true, severity: "low" }],
    });
    const result = evaluate(c, { dislikes: [] });
    expect(result.highestCountedRiskSeverity).toBe("medium");
    expect(result.autoConfirmEligible).toBe(true); // medium never blocks on its own, only high/critical
  });
});

// Odoo manufacturing feasibility — the FINAL, separate gate. Real OdooOilMapping row + mocked
// fetch, same convention as app/services/odooInventory.test.js. Uses a real FragranceProduct so
// getOilInventoryForProductTitles (title -> normalizedTitle -> FragranceProduct -> mapping) can
// actually resolve.
describe("evaluateCandidateInventory (Odoo manufacturing feasibility gate)", () => {
  const originalFetch = global.fetch;
  // "The Opera" / "Water of Arabia" already carry real mappings from the catalog import — save
  // and restore the original row (rather than blindly create/delete) so this test never corrupts
  // real seeded data, whether or not the product already had a mapping before the test ran.
  const savedOriginals = []; // { fragranceProductId, original: row|null }

  beforeEach(() => __clearOdooInventoryCacheForTesting());
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
    if (!product) throw new Error(`Test fixture assumes "${title}" exists in the real catalog.`);
    const original = await prisma.odooOilMapping.findUnique({ where: { fragranceProductId: product.id } });
    savedOriginals.push({ fragranceProductId: product.id, original });
    await prisma.odooOilMapping.upsert({
      where: { fragranceProductId: product.id },
      create: { fragranceProductId: product.id, odooSku: sku, active: true },
      update: { odooSku: sku, active: true },
    });
    return product;
  }

  // Real confirmed response shape (2026-08-11): { success, products: [{ name, default_code,
  // on_hand_qty }] } — one entry per SKU this describe block's tests actually map, so whichever
  // subset a given test's one real batched call requests, it finds a matching default_code.
  function mockOdooAvailable(onHandQty) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        success: true,
        products: [
          { name: "The Opera - Oil", default_code: "OIL-VITEST-OPERA", on_hand_qty: onHandQty },
          { name: "Water of Arabia - Oil", default_code: "OIL-VITEST-WATERARABIA", on_hand_qty: onHandQty },
        ],
      }),
    });
  }

  it("a candidate with no real catalog match for its component titles never rejects on inventory (unknown is not insufficient)", async () => {
    const result = await evaluateInventory(candidate());
    expect(result.buildable).toBe(true);
    expect(result.inventoryValidated).toBe(false);
    expect(result.components.every((c) => c.mappingStatus === "MISSING")).toBe(true);
  });

  it("rejects on a CONFIRMED insufficient oil answer from Odoo (the caller's existing fall-through then tries the next candidate)", async () => {
    await mapRealProduct("The Opera", "OIL-VITEST-OPERA");
    mockOdooAvailable(1); // 13ml default oil * 50% = 6.5ml required, only 1ml available

    const c = candidate({
      recommendedRatio: [{ productTitle: "The Opera", ratioPercent: 50 }, { productTitle: "Water of Arabia", ratioPercent: 50 }],
    });
    const result = await evaluateInventory(c);
    expect(result.buildable).toBe(false);
  });

  it("is buildable when Odoo confirms enough oil for every mapped component, and reports inventoryValidated=true", async () => {
    await mapRealProduct("The Opera", "OIL-VITEST-OPERA");
    await mapRealProduct("Water of Arabia", "OIL-VITEST-WATERARABIA");
    mockOdooAvailable(500);

    const c = candidate({
      recommendedRatio: [{ productTitle: "The Opera", ratioPercent: 50 }, { productTitle: "Water of Arabia", ratioPercent: 50 }],
    });
    const result = await evaluateInventory(c);
    expect(result.buildable).toBe(true);
    expect(result.inventoryValidated).toBe(true);
  });

  it("does NOT reject when Odoo is unreachable — a lookup failure is unknown, not confirmed insufficient — and inventoryValidated is false, not true", async () => {
    await mapRealProduct("The Opera", "OIL-VITEST-OPERA");
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const c = candidate({
      recommendedRatio: [{ productTitle: "The Opera", ratioPercent: 50 }, { productTitle: "B", ratioPercent: 50 }],
    });
    const result = await evaluateInventory(c);
    expect(result.buildable).toBe(true);
    expect(result.inventoryValidated).toBe(false);
    expect(result.components.find((ic) => ic.productTitle === "The Opera").mappingStatus).toBe("LOOKUP_FAILED");
  });

  it("batches one candidate's components into a single getOilInventoryForProductTitles call (request count reflects mapped components only)", async () => {
    await mapRealProduct("The Opera", "OIL-VITEST-OPERA");
    mockOdooAvailable(500);

    // "B" has no mapping (MISSING, no network call) — only "The Opera" should count as a request.
    const c = candidate({ recommendedRatio: [{ productTitle: "The Opera", ratioPercent: 50 }, { productTitle: "B", ratioPercent: 50 }] });
    const result = await evaluateInventory(c);
    expect(result.requestCount).toBe(1);
    expect(result.skusQueried).toEqual(["OIL-VITEST-OPERA"]);
  });
});
