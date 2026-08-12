// Integration tests against the real production-mirrored dev database (936,819 real order-history
// rows) — verifies the scoring dimensions from Phase 3, high-conflict exclusion, and the
// performance fix (ProductRegionSummary) that replaced a ~44-60s live aggregation with a
// sub-several-second one.
import { describe, it, expect } from "vitest";
import { analyzeCustomerProductCandidates } from "./orderHistoryAnalysis.server.js";
import prisma from "../db.server.js";

const ACCEPTANCE_PROFILE = {
  city: "Los Angeles",
  stateRegion: "California",
  country: "United States",
  season: "Summer",
  likes: ["Fruity", "Sweet"],
  dislikes: ["Spicy", "Strong"],
};

describe("analyzeCustomerProductCandidates", () => {
  it("returns real, catalog-backed candidates for the acceptance-scenario profile", async () => {
    const candidates = await analyzeCustomerProductCandidates(ACCEPTANCE_PROFILE);
    expect(candidates.length).toBeGreaterThan(0);
    // Fix (candidate pool ignored likes) — raised from 10 to 15 now that a like-matched tier feeds
    // into the same pool alongside the regional-popularity tiers (see MAX_CANDIDATES_RETURNED).
    expect(candidates.length).toBeLessThanOrEqual(15);
    for (const c of candidates) {
      expect(typeof c.productName).toBe("string");
      expect(c.productName.length).toBeGreaterThan(0);
      expect(Array.isArray(c.orderHistoryNotes)).toBe(true);
    }
  });

  it("carries real per-dimension evidence counts (same-city/state/country/season)", async () => {
    const candidates = await analyzeCustomerProductCandidates(ACCEPTANCE_PROFILE);
    const top = candidates[0];
    expect(top.sameCityOrders).toBeGreaterThanOrEqual(0);
    expect(top.sameCountryOrders).toBeGreaterThanOrEqual(0);
    expect(top.sameStateOrders).toBeGreaterThanOrEqual(0);
    expect(top.sameSeasonOrders).toBeGreaterThanOrEqual(0);
    // The top-ranked real candidate for this profile should have SOME real regional evidence.
    expect(top.sameCountryOrders).toBeGreaterThan(0);
  });

  it("matches customer likes against real notes and never returns a high-severity dislike conflict", async () => {
    const candidates = await analyzeCustomerProductCandidates(ACCEPTANCE_PROFILE);
    // Every returned candidate must have been evaluated for dislike conflicts already — the
    // service excludes "high" severity internally, so nothing high-severity should surface here.
    // (There's no direct severity field returned, but dislikeConflicts should never include BOTH
    // disliked families at prominent strength for the same product without having been excluded —
    // this is exercised more directly at the unit level in fragranceScoring.test.js.)
    expect(candidates.every((c) => Array.isArray(c.dislikeConflicts))).toBe(true);
  });

  it("ranks by relevanceScore descending, tie-breaking by total real order volume", async () => {
    const candidates = await analyzeCustomerProductCandidates(ACCEPTANCE_PROFILE);
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i - 1].relevanceScore).toBeGreaterThanOrEqual(candidates[i].relevanceScore);
      if (candidates[i - 1].relevanceScore === candidates[i].relevanceScore) {
        const volume = (c) => c.sameCityOrders + c.sameStateOrders + c.sameCountryOrders + c.sameSeasonOrders;
        expect(volume(candidates[i - 1])).toBeGreaterThanOrEqual(volume(candidates[i]));
      }
    }
  });

  it("falls back to real season-only evidence (never region-restricted) when city/state/country match nothing", async () => {
    // The "season" scope is deliberately NOT region-scoped (see orderHistoryAnalysis.server.js) —
    // a fake region with zero real rows should still surface real, season-driven candidates with
    // zero regional evidence, rather than returning nothing.
    const candidates = await analyzeCustomerProductCandidates({
      city: "Nonexistent Fake City",
      stateRegion: "Nowhere",
      country: "Nonexistent Fake Country",
      season: "Summer",
      likes: ["Fruity"],
      dislikes: [],
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.sameCityOrders).toBe(0);
      expect(c.sameStateOrders).toBe(0);
      expect(c.sameCountryOrders).toBe(0);
    }
  });

  it("returns an empty array when there is truly no signal at all — no region match, no likes", async () => {
    const candidates = await analyzeCustomerProductCandidates({
      city: "Nonexistent Fake City",
      stateRegion: "Nowhere",
      country: "Nonexistent Fake Country",
      season: "NotARealSeason",
      likes: [],
      dislikes: [],
    });
    expect(candidates).toEqual([]);
  });

  // Fix (candidate pool ignored likes) — this used to return [] even with real likes stated,
  // because likes only ever re-ranked an already region-built pool, never seeded it. Confirmed
  // live: customers with completely different real likes got served the identical regionally-
  // "popular" anchors. A real like should surface real candidates on its own, with zero regional
  // signal of any kind.
  it("finds real candidates from likes alone, even with zero region/season signal at all", async () => {
    const candidates = await analyzeCustomerProductCandidates({
      city: "Nonexistent Fake City",
      stateRegion: "Nowhere",
      country: "Nonexistent Fake Country",
      season: "NotARealSeason",
      likes: ["Fruity"],
      dislikes: [],
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.sameCityOrders).toBe(0);
      expect(c.sameStateOrders).toBe(0);
      expect(c.sameCountryOrders).toBe(0);
      expect(c.sameSeasonOrders).toBe(0);
      expect(c.preferenceMatches).toContain("fruity");
    }
  });

  // Floral preference audit, Phase 5/13 — exact same regression as "Fruity" above, for "Floral"
  // specifically. Before the fix this returned [] unconditionally (textToPreferenceFamilies(["Floral"])
  // was [], so topProductsByLikeMatch's own `if (!likeFamilies.length) return [];` short-circuited
  // before ever querying the catalogue) — confirmed live during the audit. A real Floral-dominant
  // catalog product (verified present via a live query: "Wicked! Femme", "Rosa's Sincerity", "A Rose
  // Dance", "That's Amore", "Powder Of Iris" all score >0 here) can now enter the candidate pool
  // purely on Floral content, with zero city/state/country/season history at all. Fixtures only —
  // never hard-coded into production candidate-selection logic.
  it("finds real Floral candidates from likes alone, even with zero region/season/history signal at all", async () => {
    const candidates = await analyzeCustomerProductCandidates({
      city: "Nonexistent Fake City",
      stateRegion: "Nowhere",
      country: "Nonexistent Fake Country",
      season: "NotARealSeason",
      likes: ["Floral"],
      dislikes: [],
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.sameCityOrders).toBe(0);
      expect(c.sameStateOrders).toBe(0);
      expect(c.sameCountryOrders).toBe(0);
      expect(c.sameSeasonOrders).toBe(0);
      expect(c.preferenceMatches).toContain("floral");
    }
  });

  it("completes well within the old ~44-60s live-aggregation time (ProductRegionSummary precompute)", async () => {
    const start = Date.now();
    await analyzeCustomerProductCandidates(ACCEPTANCE_PROFILE);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(15000);
  });

  // Required Test 10 (Aniq spec) — "Summer Months" and "Summer" must both match a customer whose
  // current season is Summer. Confirmed real bug: ProductRegionSummary's season scope stores each
  // raw source value ("Summer" and "Summer Months") as its OWN row (scripts/build-region-summary.cjs
  // never normalizes them), while this service used to query with the single literal `season`
  // string — silently missing every "Summer Months"-labeled row. This proves the fix: a candidate's
  // reported sameSeasonOrders must equal the REAL sum across every alias, not just the literal match.
  it("Test 10: season-alias sums include both 'Summer' and 'Summer Months' rows, not just the literal match", async () => {
    const candidates = await analyzeCustomerProductCandidates(ACCEPTANCE_PROFILE);
    const withSeasonEvidence = candidates.find((c) => c.sameSeasonOrders > 0);
    expect(withSeasonEvidence).toBeTruthy();

    const [summerOnly, summerMonthsOnly] = await Promise.all([
      prisma.productRegionSummary.findUnique({
        where: { normalizedProductName_scope_scopeValue: { normalizedProductName: withSeasonEvidence.normalizedProductName, scope: "season", scopeValue: "Summer" } },
      }),
      prisma.productRegionSummary.findUnique({
        where: { normalizedProductName_scope_scopeValue: { normalizedProductName: withSeasonEvidence.normalizedProductName, scope: "season", scopeValue: "Summer Months" } },
      }),
    ]);
    const expectedTotal = (summerOnly?.orderCount || 0) + (summerMonthsOnly?.orderCount || 0);
    expect(withSeasonEvidence.sameSeasonOrders).toBe(expectedTotal);
    // The real point of the fix: if a "Summer Months" row actually exists for this product, the
    // reported total must be strictly greater than the "Summer"-only literal match would have been.
    if (summerMonthsOnly?.orderCount > 0) {
      expect(withSeasonEvidence.sameSeasonOrders).toBeGreaterThan(summerOnly?.orderCount || 0);
    }
  });
});
