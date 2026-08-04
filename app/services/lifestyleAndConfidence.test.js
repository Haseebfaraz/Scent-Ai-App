// Regression suite for the lifestyle-scoring and multidimensional-confidence additions. Exercises
// generateNewProductCombinations directly against the REAL catalog (support products always come
// from the real FragranceProduct table) with CONTROLLED synthetic anchor candidates, same approach
// as aniqRegression.test.js, so the specific mechanism under test is deterministic.
import { describe, it, expect } from "vitest";
import { generateNewProductCombinations } from "./recommendationEngine.server.js";
import { executeFragranceTool, __getScratchForTesting } from "../tools/fragranceAgentTools.server.js";
import { saveCustomerProfileFields } from "./customerProfile.server.js";
import prisma from "../db.server.js";

function syntheticCandidate(overrides) {
  return {
    productName: overrides.productName,
    normalizedProductName: overrides.productName.toLowerCase(),
    collection: overrides.collection ?? null,
    relevanceScore: overrides.relevanceScore ?? 10,
    sameCityOrders: overrides.sameCityOrders ?? 0,
    sameStateOrders: overrides.sameStateOrders ?? 0,
    sameCountryOrders: overrides.sameCountryOrders ?? 0,
    sameSeasonOrders: overrides.sameSeasonOrders ?? 0,
    distinctSimilarCustomers: overrides.distinctSimilarCustomers ?? 0,
    repeatPurchaseCustomers: overrides.repeatPurchaseCustomers ?? 0,
    preferenceMatches: [],
    dislikeConflicts: [],
    classification: null,
    orderHistoryNotes: overrides.orderHistoryNotes,
    evidenceLevel: "low",
  };
}

const BASE_PROFILE = {
  city: "Los Angeles", stateRegion: "California", country: "United States", season: "Summer",
  likes: [], dislikes: [], locationVerified: true,
};

describe("Lifestyle scoring: gym", () => {
  it("a combo with airy/citrus real notes gets a positive lifestyleMatchScore when occasion mentions gym", async () => {
    const anchor = syntheticCandidate({ productName: "Test Gym Anchor", orderHistoryNotes: ["Bergamot", "Lemon", "Mint", "Aquatic Notes"] });
    const results = await generateNewProductCombinations({
      profile: { ...BASE_PROFILE, occasion: "mostly wear this to the gym" },
      candidateProducts: [anchor],
      maximumResults: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.matchedLifestyles.includes("gym"))).toBe(true);
    expect(results.some((r) => r.lifestyleMatchScore > 0)).toBe(true);
  });
});

describe("Lifestyle scoring: relaxation", () => {
  it("a combo with lavender/musk/tea real notes gets a positive lifestyleMatchScore when occasion mentions relaxing", async () => {
    const anchor = syntheticCandidate({ productName: "Test Relax Anchor", orderHistoryNotes: ["Lavender", "Musk", "Chamomile", "Tea"] });
    const results = await generateNewProductCombinations({
      profile: { ...BASE_PROFILE, occasion: "just want to relax and unwind" },
      candidateProducts: [anchor],
      maximumResults: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.matchedLifestyles.includes("relaxation"))).toBe(true);
    expect(results.some((r) => r.lifestyleMatchScore > 0)).toBe(true);
  });
});

describe("Lifestyle scoring: office + gym + unwind intersection", () => {
  it("a combination can match multiple simultaneous lifestyles at once", async () => {
    const anchor = syntheticCandidate({ productName: "Test Multi Lifestyle Anchor", orderHistoryNotes: ["Bergamot", "Musk", "Lavender", "Citrus"] });
    const results = await generateNewProductCombinations({
      profile: { ...BASE_PROFILE, occasion: "I work in an office, hit the gym after work, then like to unwind in the evening" },
      candidateProducts: [anchor],
      maximumResults: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.matchedLifestyles.length >= 2)).toBe(true);
  });
});

describe("Lifestyle cache invalidation", () => {
  it("changing occasion after candidates are cached clears candidateProducts/lastCombinations and re-generates", async () => {
    const conversationId = `vitest-lifestyle-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ctx = { conversationId, customerName: "Test", customerEmail: "test@example.com" };
    try {
      await saveCustomerProfileFields(conversationId, {
        city: "Los Angeles", country: "United States", locationVerified: true, locationSource: "order_history",
        likes: ["Fruity"],
      });

      const firstGenerate = await executeFragranceTool("generate_new_product_combinations", "{}", ctx);
      expect(firstGenerate.modelContent).not.toMatch(/^Error/);
      const scratchAfterFirst = __getScratchForTesting(conversationId);
      expect(scratchAfterFirst.candidateProducts).toBeTruthy();
      const hashAfterFirst = scratchAfterFirst.profileHash;

      // A real, recommendation-relevant change (occasion, which lifestyle scoring reads) — must
      // invalidate the cache exactly like a likes/dislikes/style change already does.
      await executeFragranceTool("save_customer_profile_field", JSON.stringify({ field: "occasion", value: "mostly for the gym" }), ctx);

      const secondGenerate = await executeFragranceTool("generate_new_product_combinations", "{}", ctx);
      expect(secondGenerate.modelContent).not.toMatch(/^Error/);
      const scratchAfterSecond = __getScratchForTesting(conversationId);
      expect(scratchAfterSecond.profileHash).not.toBe(hashAfterFirst);
      expect(scratchAfterSecond.candidateProducts).toBeTruthy();
    } finally {
      await prisma.customerProfileState.deleteMany({ where: { conversationId } });
    }
  }, 180000); // two full sequential generate_new_product_combinations cycles, each doing real DB + real copy-gen work
});

describe("Multidimensional confidence", () => {
  it("every combination carries a confidenceBreakdown with all five dimensions, each with a value and a reason", async () => {
    const anchor = syntheticCandidate({ productName: "Test Confidence Anchor", orderHistoryNotes: ["Bergamot", "Lime", "Musk"], relevanceScore: 20, sameCityOrders: 10 });
    const results = await generateNewProductCombinations({
      profile: { ...BASE_PROFILE, likes: ["Fresh"] },
      candidateProducts: [anchor],
      maximumResults: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.confidenceBreakdown).toBeTruthy();
      for (const dim of ["data", "historical", "compatibility", "novelty", "customerFit"]) {
        expect(["low", "medium", "high"]).toContain(r.confidenceBreakdown[dim].value);
        expect(typeof r.confidenceBreakdown[dim].reason).toBe("string");
        expect(r.confidenceBreakdown[dim].reason.length).toBeGreaterThan(0);
      }
    }
  });

  // Fix (remove the always-low performance dimension) — it used to always read "low" on every
  // recommendation (no real longevity/projection/sillage data exists anywhere in this system),
  // carried no real signal, never capped the overall confidence, and only ever made every result
  // look worse than the other five dimensions actually supported.
  it("no longer includes the always-low, no-signal performance dimension", async () => {
    const anchor = syntheticCandidate({ productName: "Test Performance Anchor", orderHistoryNotes: ["Oud", "Amber", "Musk"], relevanceScore: 999, sameCityOrders: 500, distinctSimilarCustomers: 200 });
    const results = await generateNewProductCombinations({
      profile: { ...BASE_PROFILE, likes: ["Strong"] },
      candidateProducts: [anchor],
      maximumResults: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.confidenceBreakdown.performance).toBeUndefined();
    }
  });

  it("existing consumers still receive the original overall confidence field, in its original shape", async () => {
    const anchor = syntheticCandidate({ productName: "Test Overall Confidence Anchor", orderHistoryNotes: ["Bergamot", "Lime"], relevanceScore: 10 });
    const results = await generateNewProductCombinations({
      profile: { ...BASE_PROFILE, likes: ["Fresh"] },
      candidateProducts: [anchor],
      maximumResults: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(["low", "medium", "high", "very high"]).toContain(r.confidence);
    }
  });

  it("low customerFit confidence (incomplete profile) caps the overall confidence at medium or below", async () => {
    const anchor = syntheticCandidate({ productName: "Test Low Fit Anchor", orderHistoryNotes: ["Bergamot", "Musk"], relevanceScore: 5 });
    const results = await generateNewProductCombinations({
      profile: { city: null, country: null, season: "Summer", likes: [], dislikes: [], locationVerified: false },
      candidateProducts: [anchor],
      maximumResults: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.confidenceBreakdown.customerFit.value).toBe("low");
      expect(["low", "medium"]).toContain(r.confidence);
    }
  });
});
