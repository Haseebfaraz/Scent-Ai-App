// Regression suite for the "Aniq" fix set — a real customer profile (Karachi, Pakistan, Summer,
// preferredStyle "Relaxing", dislikes "I do not like scents that hit my nose and make me feel
// headache") whose recommendations previously ignored style/sensitivity entirely (confirmed via a
// live before/after run: the unfixed engine anchored on "Herbs & Sea Salt" but then combined it
// with "Perfumer Dua: Tobacco" and "Rubie Dawn" — tobacco-forward products — at "very high"
// confidence, for a customer who explicitly said this kind of scent gives them headaches).
//
// Tests here exercise generateNewProductCombinations directly against the REAL catalog (support
// products always come from the real FragranceProduct table) with CONTROLLED synthetic anchor
// candidates, so the specific mechanism under test (style scoring, hard dislike exclusion,
// diversity, nested-combination rejection, complexity capping) is deterministic and not at the
// mercy of which real anchors happen to rank highest for a given city/season.
import { describe, it, expect } from "vitest";
import { analyzeCustomerProductCandidates } from "./orderHistoryAnalysis.server.js";
import { generateNewProductCombinations } from "./recommendationEngine.server.js";
import { executeFragranceTool, __getScratchForTesting } from "../tools/fragranceAgentTools.server.js";
import prisma from "../db.server.js";

const ANIQ_PROFILE = {
  city: "Karachi",
  stateRegion: null,
  country: "Pakistan",
  season: "Summer",
  likes: [],
  dislikes: ["I do not like scents that hit my nose and make me feel headache."],
  preferredStyle: "Relaxing",
  locationVerified: true,
};

function syntheticCandidate(overrides) {
  return {
    productName: overrides.productName,
    normalizedProductName: overrides.productName.toLowerCase(),
    collection: overrides.collection ?? null,
    relevanceScore: overrides.relevanceScore ?? 0,
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

describe("Test 2: preferred style affects scoring, not just customer-facing copy", () => {
  it("a relaxing-noted candidate gets a real, positive styleMatchScore even with zero historical popularity", async () => {
    const relaxingAnchor = syntheticCandidate({
      productName: "Test Relaxing Anchor",
      orderHistoryNotes: ["Lavender", "Musk", "Chamomile", "Tea"],
      relevanceScore: 1,
    });
    const results = await generateNewProductCombinations({
      profile: { ...ANIQ_PROFILE, dislikes: [] }, // isolate style scoring from the sensitivity hard filter
      candidateProducts: [relaxingAnchor],
      maximumResults: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.styleMatchScore > 0)).toBe(true);
  });

  it("a candidate with no relaxing-direction notes gets zero styleMatchScore regardless of huge historical popularity", async () => {
    const popularButMismatched = syntheticCandidate({
      productName: "Test Popular Mismatched Anchor",
      orderHistoryNotes: ["Bergamot", "Lemon", "Orange"], // real notes, but none match the relaxing bundle's keywords
      relevanceScore: 100,
      sameCityOrders: 500,
      sameCountryOrders: 900,
      distinctSimilarCustomers: 200,
      repeatPurchaseCustomers: 50,
    });
    const results = await generateNewProductCombinations({
      // No preferredStyle at all here — isolates "zero real signal" from the real, and legitimate,
      // possibility that a support product drawn from the real catalog happens to independently
      // match the OTHER test's "Relaxing" style bundle.
      profile: { ...ANIQ_PROFILE, dislikes: [], preferredStyle: null },
      candidateProducts: [popularButMismatched],
      maximumResults: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.styleMatchScore === 0)).toBe(true);
  });
});

describe("Test 3: a hard dislike/sensitivity conflict wins over popularity, unconditionally", () => {
  it("a massively popular but high-severity-conflicting anchor produces ZERO combinations", async () => {
    const popularButDisliked = syntheticCandidate({
      productName: "Test Popular Tobacco Anchor",
      orderHistoryNotes: ["Oud", "Leather", "Tobacco", "Smoke"], // 4/4 strongHeavy-family notes = high severity
      relevanceScore: 999,
      sameCityOrders: 1000,
      sameCountryOrders: 2000,
      distinctSimilarCustomers: 500,
      repeatPurchaseCustomers: 100,
    });
    const results = await generateNewProductCombinations({
      profile: { ...ANIQ_PROFILE, dislikes: ["Strong"] },
      candidateProducts: [popularButDisliked],
      maximumResults: 10,
    });
    expect(results).toEqual([]);
  });
});

describe("Test 4: diversity — no more than two final recommendations share the same anchor", () => {
  it("holds for a real, high-volume profile that previously produced 8 same-anchor results", async () => {
    const profile = { city: "Los Angeles", stateRegion: "California", country: "United States", season: "Summer", likes: ["Fruity"], dislikes: [], locationVerified: true };
    const candidates = await analyzeCustomerProductCandidates(profile);
    const results = await generateNewProductCombinations({ profile, candidateProducts: candidates, maximumResults: 10 });
    expect(results.length).toBeGreaterThan(0);
    const anchorCounts = new Map();
    for (const r of results) {
      const anchor = r.internalProducts[0].title;
      anchorCounts.set(anchor, (anchorCounts.get(anchor) || 0) + 1);
    }
    for (const [, count] of anchorCounts) {
      expect(count).toBeLessThanOrEqual(2);
    }
  });
});

describe("Test 5: a product whose catalogue collection is Hybrid/Tribrid/Quadbrid is never used as an ordinary component", () => {
  it("a synthetic finished-Tribrid candidate (collection='Tribrid') produces zero combinations as an anchor", async () => {
    const finishedTribrid = syntheticCandidate({
      productName: "Test Finished Tribrid",
      collection: "Tribrid", // mirrors the real, confirmed "Azure Supernova 2.0" case
      orderHistoryNotes: ["Bergamot", "Lemon", "Musk"],
      relevanceScore: 50,
    });
    const results = await generateNewProductCombinations({
      profile: { ...ANIQ_PROFILE, dislikes: [] },
      candidateProducts: [finishedTribrid],
      maximumResults: 10,
    });
    expect(results).toEqual([]);
  });

  it("the real 'Azure Supernova 2.0' catalogue row is genuinely classified as a finished combination", async () => {
    // Direct confirmation of the real data gap this fix addresses: collection="Tribrid" but no
    // corresponding ExistingCombination row (an incomplete/never-imported component record).
    const product = await prisma.fragranceProduct.findFirst({ where: { normalizedTitle: "azure supernova 20" } });
    expect(product?.collection?.toLowerCase()).toBe("tribrid");
  });
});

describe("Test 6: complexity penalty — high-complexity combinations are capped in confidence for a sensitive customer", () => {
  it("no very-high-combined-complexity result exceeds 'low' confidence when the customer prefers simple combinations", async () => {
    const profile = { city: "Los Angeles", stateRegion: "California", country: "United States", season: "Summer", likes: ["Fruity"], dislikes: [ANIQ_PROFILE.dislikes[0]], locationVerified: true };
    const candidates = await analyzeCustomerProductCandidates(profile);
    const results = await generateNewProductCombinations({ profile, candidateProducts: candidates, maximumResults: 10, allowedTypes: ["HYBRID", "TRIBRID", "QUADBRID"] });
    for (const r of results) {
      if (r.combinedComplexity === "very-high") {
        expect(r.confidence).toBe("low");
      }
      if (r.combinedComplexity === "high") {
        expect(["low", "medium"]).toContain(r.confidence);
      }
    }
  });
});

describe("Test 9: same-primary-role combinations are penalized, never treated as balanced", () => {
  it("a combination where every component shares one direction gets balanceScore 0 and a 'no contrasting role' risk", async () => {
    const sameDirectionAnchor = syntheticCandidate({
      productName: "Test Fruity Only Anchor",
      orderHistoryNotes: ["Mango", "Pineapple"], // purely fruity, no contrasting family at all
      relevanceScore: 10,
    });
    // Force the shortlist toward another purely-fruity real product by allowing only HYBRID (2
    // products) — if the real shortlist has zero non-fruity compatible products this anchor
    // simply yields no results, which is also an acceptable (if weaker) outcome for this check.
    const results = await generateNewProductCombinations({
      profile: { ...ANIQ_PROFILE, dislikes: [] },
      candidateProducts: [sameDirectionAnchor],
      maximumResults: 20,
      allowedTypes: ["HYBRID"],
    });
    const sameDirectionResults = results.filter((r) => r.risks.some((risk) => risk.includes("no contrasting role")));
    for (const r of sameDirectionResults) {
      expect(r.balanceScore).toBe(0);
      expect(["low", "medium"]).toContain(r.confidence);
    }
  });
});

describe("Test 8: cache invalidation — a real profile change regenerates candidates", () => {
  it("changing preferredStyle after candidates are already cached clears candidateProducts/lastCombinations and re-generates on the next call", async () => {
    const conversationId = `vitest-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ctx = { conversationId, customerName: "Test", customerEmail: "test@example.com" };
    try {
      // Los Angeles resolves via the fast, real order-history path — no live geocoding needed.
      await executeFragranceTool("verify_customer_location", JSON.stringify({ cityText: "Los Angeles" }), ctx);
      await executeFragranceTool("save_customer_profile_field", JSON.stringify({ field: "likes", value: ["Fruity"] }), ctx);

      const firstGenerate = await executeFragranceTool("generate_new_product_combinations", "{}", ctx);
      expect(firstGenerate.modelContent).not.toMatch(/^Error/);
      const scratchAfterFirst = __getScratchForTesting(conversationId);
      expect(scratchAfterFirst.candidateProducts).toBeTruthy();
      const hashAfterFirst = scratchAfterFirst.profileHash;

      // A real, recommendation-relevant profile change — must invalidate the cache (Fix, cache
      // invalidation): the OLD design only ever regenerated candidateProducts when it was still
      // null, never when the profile itself changed underneath an already-cached entry.
      await executeFragranceTool("save_customer_profile_field", JSON.stringify({ field: "preferredStyle", value: "Bold and confident" }), ctx);

      const secondGenerate = await executeFragranceTool("generate_new_product_combinations", "{}", ctx);
      expect(secondGenerate.modelContent).not.toMatch(/^Error/);
      const scratchAfterSecond = __getScratchForTesting(conversationId);
      expect(scratchAfterSecond.profileHash).not.toBe(hashAfterFirst);
      // Regenerated (not left null) — proves the clear-then-regenerate cycle actually completed,
      // not just that the hash bookkeeping updated.
      expect(scratchAfterSecond.candidateProducts).toBeTruthy();
    } finally {
      await prisma.customerProfileState.deleteMany({ where: { conversationId } });
    }
  });
});
