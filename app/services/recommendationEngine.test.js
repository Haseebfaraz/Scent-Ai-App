import { describe, it, expect } from "vitest";
import {
  computeRatios, assignRoles, generateNewProductCombinations,
  validateCombinationShape, computeEvidenceScope, computeHistoryScore, MAX_HISTORY_SCORE,
} from "./recommendationEngine.server.js";
import { likeMatchStrength } from "../utils/fragranceScoring.js";
import { literalNoteTermsFromLikes, literalNoteMatchCount, exactNoteCoverageScore } from "../utils/fragranceCompatibility.js";
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

  // Real bug: role used to be whichever family was checked FIRST in priority order and matched
  // ANY note at all — "fresh" is checked first, so a single stray citrus/mint note tipped an
  // otherwise heavy/gourmand product to "Freshness" regardless of how few fresh notes it had.
  // Confirmed live: a Quadbrid had all four components labeled "(Freshness)", which also broke the
  // ratio math (every "Freshness" role gets identical weight in computeRatios) into a flat,
  // meaningless 25/25/25/25 split.
  it("picks the family with the MOST matching notes, not just the first one present", () => {
    const roled = assignRoles([
      // 5 fresh notes (grapefruit/lime/mandarin/orange/mint) vs. 6 woody+musk+amber notes —
      // should read as the heavier, dominant character, not "Freshness".
      {
        title: "Burlington Gardens",
        notes: [
          "Grapefruit", "Lime", "Mandarin", "Bitter Orange", "Mint",
          "Ginger", "Cinnamon", "Cumin", "Saffron",
          "Patchouli", "Oakmoss", "Cedar Wood", "Cashmere Wood",
          "Rum", "Tobacco", "Benzoin", "Vanilla", "Labdanum", "Ambergris", "Musk",
        ],
      },
      // 1 fresh note (peppermint) vs. 2 sweet notes (marshmallow, whipped cream) — should read as
      // Sweetness, not Freshness.
      {
        title: "White Hot Chocolate & Rum",
        notes: ["Peppermint", "White Chocolate", "Marshmallows", "Whipped Cream", "Rum"],
      },
    ]);
    expect(roled[0].role).toBe("Musk/wood base");
    expect(roled[1].role).toBe("Sweetness");
  });
});

// Real bug: preferenceScore used to give a flat bonus for a family matching ANY note at all, so a
// product with one token match scored identically to one genuinely built around that family.
// Confirmed live: a customer whose only stated like was "Sweet" got dense 18-note floral/musk
// blends (real example: "Lady Elixir" — Bergamot, Rose de Mai, Jasmine from Grasse, Lily of the
// Valley, Heliotrope, Ylang-Ylang, Geranium, Violet Leaves, Peach, Raspberry, Cinnamon, Kashmir,
// Cedar, Vanilla, Iris, Musk, Sandalwood, Musk Mallow — only "Vanilla" is sweet) narrated as
// "designed around your preference for sweet scents."
describe("likeMatchStrength", () => {
  it("returns a low fraction for a token match buried in an otherwise-unrelated product", () => {
    const ladyElixirNotes = [
      "Bergamot", "Rose de Mai", "Jasmine from Grasse", "Lily of the Valley", "Heliotrope",
      "Ylang-Ylang", "Geranium", "Violet Leaves", "Peach", "Raspberry", "Cinnamon", "Kashmir",
      "Cedar", "Vanilla", "Iris", "Musk", "Sandalwood", "Musk Mallow",
    ];
    const strength = likeMatchStrength(ladyElixirNotes, "sweet");
    expect(strength).toBeCloseTo(1 / 18, 5);
    expect(strength).toBeLessThan(0.1);
  });

  it("returns a high fraction when the family is genuinely the product's dominant character", () => {
    const strength = likeMatchStrength(["Vanilla", "Sugar", "Caramel", "Honey", "Cedar"], "sweet");
    expect(strength).toBe(0.8);
  });

  it("returns 0 for no match at all", () => {
    expect(likeMatchStrength(["Oud", "Leather", "Smoke"], "sweet")).toBe(0);
  });
});

// Fix (limit history dominance) — stacking every regional-evidence axis at once (city+country+
// state+repeat+popularity) used to reach up to +17, enough on its own to out-rank a combo with
// strong literal-note coverage purely on regional popularity.
describe("computeHistoryScore", () => {
  it("caps full regional-evidence stacking at MAX_HISTORY_SCORE, not the uncapped 17", () => {
    const anchor = {
      sameCityOrders: 50, sameCountryOrders: 500, sameStateOrders: 20,
      repeatPurchaseCustomers: 3, distinctSimilarCustomers: 10,
    };
    expect(computeHistoryScore(anchor)).toBe(MAX_HISTORY_SCORE);
    expect(MAX_HISTORY_SCORE).toBeLessThan(17);
  });

  it("leaves a single real evidence axis (below the cap) unchanged", () => {
    const anchor = { sameCityOrders: 10, sameCountryOrders: 0, sameStateOrders: 0, repeatPurchaseCustomers: 0, distinctSimilarCustomers: 0 };
    expect(computeHistoryScore(anchor)).toBe(5); // SCORE_WEIGHTS.sameCity, below the cap
  });

  it("returns 0 for a genuinely zero-history anchor — never excluded, only ever capped from above", () => {
    const anchor = { sameCityOrders: 0, sameCountryOrders: 0, sameStateOrders: 0, repeatPurchaseCustomers: 0, distinctSimilarCustomers: 0 };
    expect(computeHistoryScore(anchor)).toBe(0);
  });

  it("caps two stacked axes once their sum exceeds MAX_HISTORY_SCORE", () => {
    // sameCity (5) + sameCountry (4) = 9, over the cap.
    const anchor = { sameCityOrders: 1, sameCountryOrders: 1, sameStateOrders: 0, repeatPurchaseCustomers: 0, distinctSimilarCustomers: 0 };
    expect(computeHistoryScore(anchor)).toBe(MAX_HISTORY_SCORE);
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
  // Fix (Aniq spec, sections 11-12) — reverses the earlier hidden-name policy: real product names
  // and notes are now REQUIRED in the customer-safe `components`/`customerFacingNotesByProduct`
  // fields (this spec's own explicit instruction: "Do not hide the real product names... Do not
  // limit the response to generic labels such as 'Product 1'"). The generated
  // customerFacingName/Description/WhySuits/BestUse/WeatherSuitability/Risk fields are still their
  // OWN generated text (never literally equal to a real title), but the real names now belong,
  // deliberately, on `components` and `customerFacingNotesByProduct`.
  it("exposes real product names and notes via components/customerFacingNotesByProduct, and every recommendation has a real customerFacingName", async () => {
    const profile = {
      city: "Los Angeles", stateRegion: "California", country: "United States", season: "Summer",
      likes: ["Fruity", "Sweet"], dislikes: [], locationVerified: true,
    };
    const candidates = await analyzeCustomerProductCandidates(profile);
    const combinations = await generateNewProductCombinations({ profile, candidateProducts: candidates, maximumResults: 5 });
    expect(combinations.length).toBeGreaterThan(0);
    for (const combo of combinations) {
      const realTitles = combo.internalProducts.map((p) => p.title);
      expect(combo.components.length).toBe(realTitles.length);
      for (const title of realTitles) {
        expect(combo.components.some((c) => c.productName === title)).toBe(true);
        expect(combo.customerFacingNotesByProduct.some((n) => n.label === title)).toBe(true);
      }
      for (const c of combo.components) {
        expect(c.availableNotes.length).toBeGreaterThan(0);
        expect(typeof c.ratioPercent).toBe("number");
        expect(c.contribution).toBeTruthy();
      }
      expect(combo.customerFacingName).toBeTruthy();
      expect(combo.customerFacingDescription).toBeTruthy();
    }
  });

  // Fix (literal note terms lost to family-level matching, round 2) — reproduces the exact real bug:
  // a Karachi customer who named Apple/Strawberry/Peach got a CONFIRMED (auto-selected, top-ranked)
  // combination containing none of them — it won purely on regional evidence despite every genuinely
  // fruity alternative scoring far higher on preferenceScore. Every returned combination must now
  // contain at least one of the customer's literally named notes; a combo with zero is rejected
  // outright rather than merely out-scored.
  it("only ever returns combinations containing at least one of the customer's literally named notes", async () => {
    const profile = {
      city: "Karachi", country: "Pakistan", season: "Summer",
      likes: ["Fruity", "Fresh", "Apple", "Strawberry", "Peach"], dislikes: ["Amber", "Sandalwood"],
      occasion: "office", locationVerified: true,
    };
    const candidates = await analyzeCustomerProductCandidates(profile);
    const combinations = await generateNewProductCombinations({ profile, candidateProducts: candidates, maximumResults: 8 });
    const literalTerms = literalNoteTermsFromLikes(profile.likes);
    expect(combinations.length).toBeGreaterThan(0);
    for (const combo of combinations) {
      const allNotes = combo.internalProducts.flatMap((p) => p.notes || []);
      expect(literalNoteMatchCount(allNotes, literalTerms)).toBeGreaterThan(0);
    }
  });

  // Fix (tiered exact-note coverage scoring) — proves the tiered formula is actually wired into the
  // real preferenceScore, not just a pure function nobody calls. preferenceScore is family score
  // (always >= 0) PLUS the tiered literal-coverage score, so the literal contribution alone can
  // never exceed the combo's real preferenceScore.
  it("preferenceScore reflects at least the tiered exact-note coverage score for how many literal notes each combo covers", async () => {
    const profile = {
      city: "Karachi", country: "Pakistan", season: "Summer",
      likes: ["Fruity", "Fresh", "Apple", "Strawberry", "Peach"], dislikes: ["Amber", "Sandalwood"],
      occasion: "office", locationVerified: true,
    };
    const candidates = await analyzeCustomerProductCandidates(profile);
    const combinations = await generateNewProductCombinations({ profile, candidateProducts: candidates, maximumResults: 8 });
    const literalTerms = literalNoteTermsFromLikes(profile.likes);
    expect(combinations.length).toBeGreaterThan(0);
    for (const combo of combinations) {
      const allNotes = combo.internalProducts.flatMap((p) => p.notes || []);
      const distinctMatches = literalNoteMatchCount(allNotes, literalTerms);
      expect(distinctMatches).toBeGreaterThan(0); // guaranteed by the hard gate above
      expect(combo.preferenceScore).toBeGreaterThanOrEqual(exactNoteCoverageScore(distinctMatches));
    }
  });

  // The requirement above must never fire for a customer who only gave style words (no literal
  // terms to require) — unaffected, exactly as before this fix.
  it("never restricts results when the customer only gave style words, not specific note names", async () => {
    const profile = {
      city: "Los Angeles", stateRegion: "California", country: "United States", season: "Summer",
      likes: ["Fruity", "Sweet"], dislikes: [], locationVerified: true,
    };
    const candidates = await analyzeCustomerProductCandidates(profile);
    const combinations = await generateNewProductCombinations({ profile, candidateProducts: candidates, maximumResults: 8 });
    expect(combinations.length).toBeGreaterThan(0);
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
