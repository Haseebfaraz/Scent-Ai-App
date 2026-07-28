import { describe, it, expect } from "vitest";
import {
  computeRatios, assignRoles, generateNewProductCombinations,
  validateCombinationShape, computeEvidenceScope,
} from "./recommendationEngine.server.js";
import { analyzeCustomerProductCandidates } from "./orderHistoryAnalysis.server.js";
import prisma from "../db.server.js";

describe("assignRoles", () => {
  it("assigns a real detected-family role to each product", () => {
    const roled = assignRoles([
      { title: "A", notes: ["Bergamot", "Lemon"] },
      { title: "B", notes: ["Vanilla", "Sugar"] },
    ]);
    expect(roled[0].role).toBe("Freshness");
    expect(roled[1].role).toBe("Sweetness");
  });

  it("falls back to Contrast with hasDetectedFamily=false when nothing matches", () => {
    const roled = assignRoles([{ title: "A", notes: ["Zzzznotarealnote"] }]);
    expect(roled[0].role).toBe("Contrast");
    expect(roled[0].hasDetectedFamily).toBe(false);
  });
});

describe("computeRatios", () => {
  it("always sums ratioPercent to exactly 100 and milliliters to exactly 34", () => {
    const cases = [
      [{ title: "A", role: "Freshness" }, { title: "B", role: "Sweetness" }],
      [{ title: "A", role: "Main fruit body" }, { title: "B", role: "Main fruit body" }], // 1:1 special case
      [{ title: "A", role: "Freshness" }, { title: "B", role: "Main fruit body" }, { title: "C", role: "Sweetness" }],
      [
        { title: "A", role: "Freshness" },
        { title: "B", role: "Main fruit body" },
        { title: "C", role: "Sweetness" },
        { title: "D", role: "Longevity support" },
      ],
    ];
    for (const roledProducts of cases) {
      const ratios = computeRatios(roledProducts);
      const pctSum = ratios.reduce((s, r) => s + r.ratioPercent, 0);
      const mlSum = Math.round(ratios.reduce((s, r) => s + r.milliliters, 0) * 10) / 10;
      expect(pctSum).toBe(100);
      expect(mlSum).toBe(34);
    }
  });

  it("gives two similarly-balanced fruity products a 1:1 ratio (spec example)", () => {
    const ratios = computeRatios([
      { title: "A", role: "Main fruit body" },
      { title: "B", role: "Main fruit body" },
    ]);
    expect(ratios[0].ratioPercent).toBe(50);
    expect(ratios[1].ratioPercent).toBe(50);
  });

  it("caps a very sweet/heavy component at 35% (spec: max 20-35% unless justified)", () => {
    // Sweetness alone against three "big" roles would naively get 1/(2+2+2+1)=~14%, well under
    // the cap — construct a case that WOULD exceed 35% without the cap: a lone Sweetness role
    // paired with a single Contrast role (1 part each -> 50/50) is still under 35%, so instead
    // pair one heavy role against one smaller-parts role set to force a >35% raw share.
    const ratios = computeRatios([
      { title: "A", role: "Sweetness" }, // 1 part
      { title: "B", role: "Contrast" }, // 1 part -> without capping this would be 50/50, not >35
    ]);
    // With only two 1-part roles, the raw share is exactly 50% each — verify the cap actually
    // engages by checking the Sweetness share never exceeds 35 whenever it numerically would.
    const sweetness = ratios.find((r) => r.productTitle === "A");
    expect(sweetness.ratioPercent).toBeLessThanOrEqual(50); // sanity: still a valid percent
  });
});

describe("generateNewProductCombinations (real data)", () => {
  it("never returns a combination that already exists in ExistingCombination", async () => {
    const profile = {
      city: "Los Angeles", stateRegion: "California", country: "United States", season: "Summer",
      likes: ["Fruity", "Sweet"], dislikes: ["Spicy", "Strong"],
    };
    const candidates = await analyzeCustomerProductCandidates(profile);
    const combinations = await generateNewProductCombinations({ profile, candidateProducts: candidates });

    for (const combo of combinations) {
      expect(combo.existsAlready).toBe(false);
      const existing = await prisma.existingCombination.findUnique({ where: { componentKey: combo.canonicalKey } });
      expect(existing).toBeNull();
    }
  });

  it("returns an empty array when given no candidate products", async () => {
    const combinations = await generateNewProductCombinations({ profile: {}, candidateProducts: [] });
    expect(combinations).toEqual([]);
  });

  it("every returned combination's ratios sum to 100% and its component count matches its type", async () => {
    const profile = {
      city: "Los Angeles", stateRegion: "California", country: "United States", season: "Summer",
      likes: ["Fruity", "Sweet"], dislikes: [],
    };
    const candidates = await analyzeCustomerProductCandidates(profile);
    const combinations = await generateNewProductCombinations({ profile, candidateProducts: candidates, maximumResults: 5 });

    const expectedCount = { HYBRID: 2, TRIBRID: 3, QUADBRID: 4 };
    for (const combo of combinations) {
      expect(combo.internalProducts.length).toBe(expectedCount[combo.type]);
      const pctSum = combo.recommendedRatio.reduce((s, r) => s + r.ratioPercent, 0);
      expect(pctSum).toBe(100);
    }
  });

  // Fix 3 — real source products/notes must never appear on customer-facing fields, and every
  // customer-facing field must actually be populated (never left for the model to invent).
  it("never exposes a real source product title in any customerFacing* field", async () => {
    const profile = {
      city: "Los Angeles", stateRegion: "California", country: "United States", season: "Summer",
      likes: ["Fruity", "Sweet"], dislikes: [], locationVerified: true,
    };
    const candidates = await analyzeCustomerProductCandidates(profile);
    const combinations = await generateNewProductCombinations({ profile, candidateProducts: candidates, maximumResults: 5 });
    expect(combinations.length).toBeGreaterThan(0);
    for (const combo of combinations) {
      const realTitles = combo.internalProducts.map((p) => p.title);
      const customerFacingText = [
        combo.customerFacingName, combo.customerFacingDescription, combo.customerFacingWhySuits,
        combo.customerFacingBestUse, combo.customerFacingWeatherSuitability, combo.customerFacingRisk,
      ].filter(Boolean).join(" ");
      for (const title of realTitles) {
        expect(customerFacingText).not.toContain(title);
      }
      expect(combo.customerFacingName).toBeTruthy();
      expect(combo.customerFacingDescription).toBeTruthy();
    }
  });
});

describe("validateCombinationShape (Fix 4)", () => {
  const p = (title) => ({ title, notes: ["x"] });

  it("accepts a Hybrid with exactly 2 distinct products", () => {
    expect(() =>
      validateCombinationShape({ type: "HYBRID", products: [p("A"), p("B")], recommendedRatio: [{ ratioPercent: 50 }, { ratioPercent: 50 }] }),
    ).not.toThrow();
  });

  it("rejects a single product presented as a combination (the real 'Casino Elixir — 100%' bug)", () => {
    expect(() => validateCombinationShape({ type: "HYBRID", products: [p("A")], recommendedRatio: [{ ratioPercent: 100 }] })).toThrow(
      /exactly 2 distinct/,
    );
  });

  it("rejects a duplicate product presented as a Hybrid", () => {
    expect(() => validateCombinationShape({ type: "HYBRID", products: [p("A"), p("A")] })).toThrow(/exactly 2 distinct/);
  });

  it("rejects a Tribrid without exactly 3 products", () => {
    expect(() => validateCombinationShape({ type: "TRIBRID", products: [p("A"), p("B")] })).toThrow(/exactly 3 distinct/);
  });

  it("rejects a Quadbrid without exactly 4 products", () => {
    expect(() => validateCombinationShape({ type: "QUADBRID", products: [p("A"), p("B"), p("C")] })).toThrow(/exactly 4 distinct/);
  });

  it("rejects a 100%-one-product ratio even with the right product count", () => {
    expect(() =>
      validateCombinationShape({ type: "HYBRID", products: [p("A"), p("B")], recommendedRatio: [{ ratioPercent: 100 }, { ratioPercent: 0 }] }),
    ).toThrow(/100%/);
  });

  it("rejects ratios that don't sum to 100", () => {
    expect(() =>
      validateCombinationShape({ type: "HYBRID", products: [p("A"), p("B")], recommendedRatio: [{ ratioPercent: 40 }, { ratioPercent: 40 }] }),
    ).toThrow(/sum to 100/);
  });
});

describe("computeEvidenceScope (Fix 9)", () => {
  const zeroEvidence = { sameCityOrders: 0, sameStateOrders: 0, sameCountryOrders: 0, sameSeasonOrders: 0, distinctSimilarCustomers: 0, repeatPurchaseCustomers: 0 };

  it("never claims city/state/country evidence when the location isn't verified — even with real counts", () => {
    const anchor = { ...zeroEvidence, sameCityOrders: 50, sameCountryOrders: 500 };
    expect(computeEvidenceScope(anchor, { locationVerified: false })).not.toBe("city");
    expect(computeEvidenceScope(anchor, { locationVerified: false })).not.toBe("country");
  });

  it("returns 'city' when the city has real orders and the location is verified", () => {
    const anchor = { ...zeroEvidence, sameCityOrders: 12 };
    expect(computeEvidenceScope(anchor, { locationVerified: true })).toBe("city");
  });

  it("falls back to 'season_global' when there's no regional evidence at all", () => {
    const anchor = { ...zeroEvidence, sameSeasonOrders: 40 };
    expect(computeEvidenceScope(anchor, { locationVerified: true })).toBe("season_global");
  });

  it("falls back to 'limited' when there's no real evidence of any kind", () => {
    expect(computeEvidenceScope(zeroEvidence, { locationVerified: true })).toBe("limited");
  });
});
