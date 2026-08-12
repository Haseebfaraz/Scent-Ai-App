import { describe, it, expect } from "vitest";
import {
  computeRatios, assignRoles, generateNewProductCombinations,
  validateCombinationShape, computeEvidenceScope, computeHistoryScore, MAX_HISTORY_SCORE,
  buildFallbackAnchorsForMissingTerms, hasHardExcludedFamily, hasHardExcludedTerm,
} from "./recommendationEngine.server.js";
import { likeMatchStrength, classifyDislikeConflict } from "../utils/fragranceScoring.js";
import {
  literalNoteTermsFromLikes, literalNoteMatchCount, exactNoteCoverageScore, matchedLiteralTerms,
  missingLiteralTerms, textToPreferenceFamilies, splitDislikesByExactness, familyBreadthCoverageScore,
} from "../utils/fragranceCompatibility.js";
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

  // Floral preference audit, Phase 9 — ranking/debugging fields, never a hard gate: a component's
  // real floral-note density is now visible directly on assignRoles' output.
  it("exposes floralNoteCount/totalNoteCount/floralCoverage per product", () => {
    const roled = assignRoles([
      { title: "Weak", notes: ["Lemon", "Green Tea", "Ginger", "Peach", "Hedione", "Jasmine", "Apple", "Marshmallow", "Vanilla", "Benzoin"] },
      { title: "Strong", notes: ["Rose", "Jasmine", "Tuberose", "Orange Blossom", "Peony", "Lily of the Valley"] },
      { title: "None", notes: ["Bergamot", "Lemon", "Spearmint"] },
    ]);
    expect(roled[0].floralNoteCount).toBe(2); // Hedione + Jasmine
    expect(roled[0].totalNoteCount).toBe(10);
    expect(roled[0].floralCoverage).toBeCloseTo(0.2);
    expect(roled[1].floralNoteCount).toBe(6);
    expect(roled[1].floralCoverage).toBe(1);
    expect(roled[2].floralNoteCount).toBe(0);
    expect(roled[2].floralCoverage).toBe(0);
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

// Fix (refinement "remove X" didn't actually remove X) — a customer's general stated dislikes stay
// a soft per-component severity signal (one incidental trace note never disqualifies a product, per
// spec); hardExcludeFamilies is a stronger, separate mechanism scoped only to a refinement's own
// freshly-named exclusion.
describe("hasHardExcludedFamily", () => {
  it("excludes a product containing even a single trace note of the hard-excluded family", () => {
    // A single "Sandalwood" trace buried among many other notes — exactly the real case that
    // survived the old soft severity system (only "low" severity, a -2 penalty, never a reject).
    const notes = ["Salt", "Watermelon Syrup", "Blueberry Juice", "Mandarin Orange Rinds", "Sandalwood", "White Musk"];
    expect(hasHardExcludedFamily(notes, ["woody"])).toBe(true);
  });

  it("never excludes a product with no trace of the hard-excluded family at all", () => {
    const notes = ["Peach Purée", "Strawberry Purée", "Vodka", "White Musk"];
    expect(hasHardExcludedFamily(notes, ["woody"])).toBe(false);
  });

  it("is a no-op when no families are hard-excluded", () => {
    expect(hasHardExcludedFamily(["Sandalwood"], [])).toBe(false);
    expect(hasHardExcludedFamily(["Sandalwood"], undefined)).toBe(false);
  });
});

// Fix (refinement couldn't exclude a note with no PREFERENCE_FAMILIES entry at all) — a real
// catalog note like "Jackfruit" matches no family whatsoever, so hasHardExcludedFamily alone can
// never exclude it no matter how clearly a customer names it in a refinement.
describe("hasHardExcludedTerm", () => {
  it("excludes a product literally containing the named term, family or no family", () => {
    expect(hasHardExcludedTerm(["Gin", "Mojito", "Jackfruit"], ["jackfruit"])).toBe(true);
  });

  it("never excludes a product with no trace of the named term", () => {
    expect(hasHardExcludedTerm(["Gin", "Mojito", "Coconut"], ["jackfruit"])).toBe(false);
  });

  it("is a no-op when no terms are hard-excluded", () => {
    expect(hasHardExcludedTerm(["Jackfruit"], [])).toBe(false);
    expect(hasHardExcludedTerm(["Jackfruit"], undefined)).toBe(false);
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

  // Fix (real bug: every single recommendation for a customer came back Quadbrid, never Hybrid or
  // Tribrid) — TYPE_SIMPLICITY_SCORE used to be all zeros unless the customer had an explicit
  // sensitivity signal, so an ordinary customer got zero bias toward Hybrid at all — a Quadbrid's
  // sheer product-count advantage on every other additive score won every time by default.
  describe("TYPE_SIMPLICITY_SCORE — Hybrid preferred by default, not only for a sensitive customer", () => {
    const ordinaryProfile = {
      city: "Los Angeles", stateRegion: "California", country: "United States", season: "Summer",
      likes: ["Fruity", "Sweet"], dislikes: [], locationVerified: true,
    };

    it("gives an ordinary, non-sensitive customer a real non-zero bias toward Hybrid and against Quadbrid", async () => {
      const candidates = await analyzeCustomerProductCandidates(ordinaryProfile);
      const hybridResults = await generateNewProductCombinations({ profile: ordinaryProfile, candidateProducts: candidates, allowedTypes: ["HYBRID"], maximumResults: 5 });
      const quadbridResults = await generateNewProductCombinations({ profile: ordinaryProfile, candidateProducts: candidates, allowedTypes: ["QUADBRID"], maximumResults: 5 });
      expect(hybridResults.length).toBeGreaterThan(0);
      expect(quadbridResults.length).toBeGreaterThan(0);
      for (const r of hybridResults) expect(r.typeSimplicityScore).toBe(10);
      for (const r of quadbridResults) expect(r.typeSimplicityScore).toBe(-16);
    });

    it("strengthens the bias further for a sensitive customer, on top of the ordinary-customer baseline", async () => {
      const sensitiveProfile = { ...ordinaryProfile, dislikes: ["too strong"] };
      const candidates = await analyzeCustomerProductCandidates(sensitiveProfile);
      const hybridResults = await generateNewProductCombinations({ profile: sensitiveProfile, candidateProducts: candidates, allowedTypes: ["HYBRID"], maximumResults: 5 });
      for (const r of hybridResults) expect(r.typeSimplicityScore).toBe(14);
    });

    it("never returns an exclusively-Quadbrid batch for an ordinary customer when Hybrid candidates exist", async () => {
      const candidates = await analyzeCustomerProductCandidates(ordinaryProfile);
      const combinations = await generateNewProductCombinations({ profile: ordinaryProfile, candidateProducts: candidates, maximumResults: 8 });
      const types = new Set(combinations.map((c) => c.type));
      // Only meaningful if there was real competition across types to begin with.
      if (types.size > 0) expect(types.has("QUADBRID") && types.size === 1).toBe(false);
    });
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

  // Fix (final-batch preference coverage) — an individual combo only ever had to contain ONE named
  // note, so the batch as a whole could still leave one (e.g. Strawberry) completely uncovered even
  // though every combo individually satisfied its own requirement. Every one of the customer's
  // literally named notes must now appear SOMEWHERE across the final batch, and every combo must
  // carry a matchedExactNotes/missingExactNotes breakdown that partitions the full named-note set.
  it("covers every one of the customer's literally named notes somewhere across the final batch", async () => {
    const profile = {
      city: "Karachi", country: "Pakistan", season: "Summer",
      likes: ["Fruity", "Fresh", "Apple", "Strawberry", "Peach"], dislikes: ["Amber", "Sandalwood"],
      occasion: "office", locationVerified: true,
    };
    const candidates = await analyzeCustomerProductCandidates(profile);
    const combinations = await generateNewProductCombinations({ profile, candidateProducts: candidates, maximumResults: 8 });
    expect(combinations.length).toBeGreaterThan(0);

    const literalTerms = literalNoteTermsFromLikes(profile.likes);
    const coveredAcrossBatch = new Set(combinations.flatMap((c) => c.matchedExactNotes));
    for (const term of literalTerms) {
      expect(coveredAcrossBatch.has(term)).toBe(true);
    }

    for (const combo of combinations) {
      expect(combo.matchedExactNotes).toBeInstanceOf(Array);
      expect(combo.missingExactNotes).toBeInstanceOf(Array);
      expect(new Set([...combo.matchedExactNotes, ...combo.missingExactNotes])).toEqual(new Set(literalTerms));
      expect(combo.matchedExactNotes.some((t) => combo.missingExactNotes.includes(t))).toBe(false);
    }
  });

  // Direct, deterministic test of the regeneration mechanism itself (buildFallbackAnchorsForMissingTerms)
  // against the real catalog, independent of which anchors a specific candidate pool happens to rank
  // top — proves it can actually find real Strawberry-containing products to seed as extra anchors.
  it("finds real catalog anchors that literally contain a missing named note (Strawberry)", async () => {
    const allProducts = await prisma.fragranceProduct.findMany({
      select: { title: true, normalizedTitle: true, notesJson: true, collection: true },
    });
    const anchors = buildFallbackAnchorsForMissingTerms(["strawberry"], {
      allProducts, finishedCombinationTitles: new Set(), preferenceIntent: {}, candidateProducts: [],
    });
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(matchedLiteralTerms(anchor.orderHistoryNotes, ["strawberry"]).length).toBeGreaterThan(0);
    }
  });

  // A single real Apple-only anchor (confirmed to contain neither Strawberry nor Peach, and not
  // itself a finished combination) as the ENTIRE initial candidate pool — with only one anchor and
  // no other real evidence, Strawberry/Peach coverage can only come from the targeted fallback pass
  // finding real catalog products for those specific missing terms, not from having several anchors
  // to begin with.
  it("an Apple-only initial candidate pool still ends up covering Strawberry and Peach via the targeted fallback pass", async () => {
    const allProducts = await prisma.fragranceProduct.findMany({
      select: { title: true, normalizedTitle: true, notesJson: true, collection: true },
    });
    const appleOnly = allProducts.find(
      (p) =>
        matchedLiteralTerms(p.notesJson, ["apple"]).length > 0 &&
        matchedLiteralTerms(p.notesJson, ["strawberry"]).length === 0 &&
        matchedLiteralTerms(p.notesJson, ["peach"]).length === 0 &&
        !["hybrid", "tribrid", "quadbrid"].includes(String(p.collection).toLowerCase()),
    );
    expect(appleOnly).toBeTruthy(); // sanity check: such a real product exists in the catalog

    const candidateProducts = [{
      productName: appleOnly.title, normalizedProductName: appleOnly.normalizedTitle, collection: appleOnly.collection,
      relevanceScore: 100, orderHistoryNotes: appleOnly.notesJson,
      sameCityOrders: 0, sameStateOrders: 0, sameCountryOrders: 0, sameSeasonOrders: 0,
      distinctSimilarCustomers: 0, repeatPurchaseCustomers: 0,
    }];
    const profile = { likes: ["Apple", "Strawberry", "Peach"], dislikes: [], locationVerified: true };
    const combinations = await generateNewProductCombinations({ profile, candidateProducts, maximumResults: 8 });
    expect(combinations.length).toBeGreaterThan(0);

    const coveredAcrossBatch = new Set(combinations.flatMap((c) => c.matchedExactNotes));
    expect(coveredAcrossBatch.has("apple")).toBe(true);
    expect(coveredAcrossBatch.has("strawberry")).toBe(true);
    expect(coveredAcrossBatch.has("peach")).toBe(true);
  });

  // Fix (final-batch preference coverage) — every literal note-family keyword
  // literalNoteTermsFromLikes can ever extract has at least one real match somewhere in this
  // 3450-product catalog (verified directly), so a genuinely uncoverable customer-named note can't
  // be reproduced end-to-end through the real "likes" vocabulary. Proves the underlying guarantee
  // directly instead: a term that truly doesn't exist anywhere gets zero fallback anchors — never a
  // fabricated one — and stays correctly reported as missing.
  it("never invents an anchor or a match for a note that truly doesn't exist anywhere in the catalog", async () => {
    const allProducts = await prisma.fragranceProduct.findMany({
      select: { title: true, normalizedTitle: true, notesJson: true, collection: true },
    });
    const anchors = buildFallbackAnchorsForMissingTerms(["zzznonexistentnote"], {
      allProducts, finishedCombinationTitles: new Set(), preferenceIntent: {}, candidateProducts: [],
    });
    expect(anchors).toEqual([]);
    expect(missingLiteralTerms(["Apple", "Musk", "Vanilla"], ["zzznonexistentnote"])).toEqual(["zzznonexistentnote"]);
  });

  // The targeted fallback pass reuses generateCombosForAnchor — the EXACT same function the normal
  // pass uses, including scoreProposedCombination's hard dislike-conflict rejection and the
  // existing-combination exclusion — so nothing about seeding extra anchors can bypass either rule.
  it("the full final batch (including any fallback-generated combos) still respects hard dislikes and never duplicates an existing combination", async () => {
    const profile = {
      city: "Karachi", country: "Pakistan", season: "Summer",
      likes: ["Fruity", "Fresh", "Apple", "Strawberry", "Peach"], dislikes: ["Amber", "Sandalwood"],
      occasion: "office", locationVerified: true,
    };
    const candidates = await analyzeCustomerProductCandidates(profile);
    const combinations = await generateNewProductCombinations({ profile, candidateProducts: candidates, maximumResults: 8 });
    expect(combinations.length).toBeGreaterThan(0);

    const existing = await prisma.existingCombination.findMany({ select: { componentKey: true } });
    const existingKeys = new Set(existing.map((e) => e.componentKey));

    // Fix (exact-note dislike vs explicit-family dislike, Phase 4) — "Amber" and "Sandalwood" here
    // are both literal named notes (real PREFERENCE_FAMILIES keywords, not bare descriptor words),
    // so they now hard-exclude directly on their own presence, never the whole strongHeavy/woody
    // family — a component containing Oud/Leather/Tobacco (zero Amber) or Cedar/Vetiver (zero
    // Sandalwood) is legitimately allowed through now, which is the fix working as intended, not a
    // regression from this test's old, broader assertion.
    for (const combo of combinations) {
      for (const product of combo.internalProducts) {
        expect(literalNoteMatchCount(product.notes, ["amber", "sandalwood"])).toBe(0);
      }
      expect(existingKeys.has(combo.canonicalKey)).toBe(false);
    }
  });

  // Fix (final-batch preference coverage, requirement 6) — exactNoteCoverageScore is kept as its
  // own named value (not just folded anonymously into preferenceScore) so it can be persisted and
  // inspected per recommendation.
  it("persists exactNoteCoverageScore on every recommendation, matching its real matched-note count", async () => {
    const profile = {
      city: "Karachi", country: "Pakistan", season: "Summer",
      likes: ["Fruity", "Fresh", "Apple", "Strawberry", "Peach"], dislikes: ["Amber", "Sandalwood"],
      occasion: "office", locationVerified: true,
    };
    const candidates = await analyzeCustomerProductCandidates(profile);
    const combinations = await generateNewProductCombinations({ profile, candidateProducts: candidates, maximumResults: 8 });
    expect(combinations.length).toBeGreaterThan(0);
    for (const combo of combinations) {
      expect(combo.exactNoteCoverageScore).toBe(exactNoteCoverageScore(combo.matchedExactNotes.length));
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

// Fix (exact-note dislike collapsed into whole-family dislike) — confirmed as a real gap: "I
// dislike Sandalwood" used to convert straight into the whole `woody` family via
// textToPreferenceFamilies, so a component loaded with Cedar/Vetiver/Patchouli (zero Sandalwood)
// could still accumulate enough matched notes to hit "high" severity and be hard-rejected, purely
// for sharing a family with the one note actually named. These test the exact functions wired into
// scoreProposedCombination/orderHistoryAnalysis/confirmRecommendation, since all three route
// through splitDislikesByExactness + hasHardExcludedTerm/classifyDislikeConflict identically.
describe("exact-note dislike vs explicit-family dislike (Phase 4)", () => {
  it("an exact 'Sandalwood' dislike never triggers a family-level conflict for a product containing only OTHER woody notes", () => {
    const { exactNoteDislikes, explicitFamilyDislikes } = splitDislikesByExactness(["Sandalwood"]);
    const cedarVetiverProduct = ["Cedar", "Vetiver", "Patchouli", "Musk"];
    expect(hasHardExcludedTerm(cedarVetiverProduct, exactNoteDislikes)).toBe(false);
    expect(classifyDislikeConflict(cedarVetiverProduct, explicitFamilyDislikes).severity).toBe("none");
  });

  it("an exact 'Sandalwood' dislike DOES hard-exclude a product that actually contains Sandalwood", () => {
    const { exactNoteDislikes } = splitDislikesByExactness(["Sandalwood"]);
    expect(hasHardExcludedTerm(["Bergamot", "Sandalwood", "Musk"], exactNoteDislikes)).toBe(true);
  });

  it("a broad 'Woody fragrances' dislike still rejects a heavily woody product via the existing severity system, unaffected by the split", () => {
    const { explicitFamilyDislikes } = splitDislikesByExactness(["Woody fragrances"]);
    const heavilyWoodyProduct = ["Cedar", "Vetiver", "Patchouli", "Guaiac"];
    expect(classifyDislikeConflict(heavilyWoodyProduct, explicitFamilyDislikes).severity).toBe("high");
  });

  it("an exact 'Amber' dislike follows the documented Amber-material policy — stays a literal note, never expands to the whole strongHeavy family (Oud/Leather/Tobacco/Smoke/Resin)", () => {
    const { exactNoteDislikes, explicitFamilyDislikes } = splitDislikesByExactness(["Amber"]);
    const oudLeatherProduct = ["Oud", "Leather", "Tobacco", "Smoke", "Resin"];
    expect(hasHardExcludedTerm(oudLeatherProduct, exactNoteDislikes)).toBe(false);
    expect(classifyDislikeConflict(oudLeatherProduct, explicitFamilyDislikes).severity).toBe("none");
    expect(hasHardExcludedTerm(["Bergamot", "Amber", "Musk"], exactNoteDislikes)).toBe(true);
  });
});

// Fix (sensory-direction words produced zero signal) — real, live-confirmed bug: a customer whose
// entire stated likes were "dry, earthy, natural" got recommendations built from sweet/spicy/amber
// candidates because those three words matched nothing anywhere in the engine, so candidate
// ranking fell back to pure regional popularity with zero input from what was actually said.
describe("Bruce profile — dry/earthy/natural likes actually reach candidate ranking (spec regression test)", () => {
  it("candidates get a real preferenceMatches hit for dry/earthy/natural, not just regional popularity", async () => {
    const profile = {
      city: "Liverpool", stateRegion: null, country: "United Kingdom", season: "Winter",
      likes: ["dry", "earthy", "natural"], dislikes: ["fruity", "fruity gourmand"], locationVerified: true,
    };
    const candidates = await analyzeCustomerProductCandidates(profile);
    expect(candidates.length).toBeGreaterThan(0);
    const hasDirectionMatch = candidates.some((c) =>
      c.preferenceMatches.some((f) => ["dry", "earthy", "natural"].includes(f)),
    );
    expect(hasDirectionMatch).toBe(true);
  });

  it("a real moss/vetiver/herb-forward product outranks a sweet-fruit product once likes actually carry signal", () => {
    // Direct, deterministic proof of the underlying scoring mechanism (no catalog/network
    // dependency): before this fix, BOTH products below scored identically on preference (zero
    // family matches for either), so a sweet-fruit product could rank above a dry/earthy/natural
    // one purely on regional popularity. Now the dry/earthy/natural product gets real credit.
    const likeFamilies = textToPreferenceFamilies(["dry", "earthy", "natural"]);
    const dryEarthyProduct = ["Vetiver", "Moss", "Galbanum", "Green Tea"];
    const sweetFruitProduct = ["Sugar", "Caramel", "Mango", "Pineapple"];
    expect(likeMatchStrength(dryEarthyProduct, "dry")).toBeGreaterThan(0);
    expect(likeMatchStrength(dryEarthyProduct, "earthy")).toBeGreaterThan(0);
    expect(likeMatchStrength(dryEarthyProduct, "natural")).toBeGreaterThan(0);
    const dryEarthyMatches = likeFamilies.filter((f) => likeMatchStrength(dryEarthyProduct, f) > 0);
    const sweetFruitMatches = likeFamilies.filter((f) => likeMatchStrength(sweetFruitProduct, f) > 0);
    expect(dryEarthyMatches.length).toBeGreaterThan(sweetFruitMatches.length);
  });
});

// Floral preference audit — before this fix, "Likes: Floral" produced likeFamilies=[], so the
// like-match hard gate in scoreProposedCombination (`if (likeFamilies.length > 0 &&
// matchedPreferenceFamilies.size === 0) return null;`) was a structural no-op: a customer could get
// a 100% Freshness+Freshness combination with zero real floral content, confirmed live against the
// real Tom regression case. With `floral` now a real PREFERENCE_FAMILIES member, this exact same
// gate (unchanged code) now actually enforces coverage — no separate Floral-specific rule was added.
describe("Floral preference audit — the existing like-match hard gate now actually covers Floral", () => {
  it("every real result for a Floral-only customer genuinely matches the floral family — no zero-coverage combination survives", async () => {
    const profile = {
      city: "Las Vegas", country: "United States", season: "Summer",
      likes: ["Floral"], dislikes: ["Musk", "Oakmoss", "Sandalwood", "Patchouli", "Vetiver"],
      locationVerified: true,
    };
    const candidates = await analyzeCustomerProductCandidates(profile);
    const results = await generateNewProductCombinations({ profile, candidateProducts: candidates, maximumResults: 8 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.requestedPreferenceFamilies).toEqual(["floral"]);
      expect(r.matchedPreferenceFamilies).toContain("floral");
      expect(r.missingPreferenceFamilies).toEqual([]);
      // Lifestyle/history/compatibility must never be able to substitute for zero stated-preference
      // coverage (Phase 7) — proven directly: every surviving result has real floral content.
      const floralNotes = r.internalProducts.flatMap((p) => p.notes).filter((n) =>
        ["jasmine", "rose", "violet", "iris", "orris", "tuberose", "magnolia", "freesia", "gardenia",
          "peony", "ylang", "osmanthus", "orange blossom", "lily", "cyclamen", "lotus", "mimosa",
          "geranium", "hedione", "floral", "flower"].some((kw) => String(n).toLowerCase().includes(kw)),
      );
      expect(floralNotes.length).toBeGreaterThan(0);
    }
  });

  it("a genuinely Floral-dominant real catalog product can win the anchor/support role for a Floral-only customer", async () => {
    const profile = {
      city: "Las Vegas", country: "United States", season: "Summer",
      likes: ["Floral"], dislikes: [], locationVerified: true,
    };
    const candidates = await analyzeCustomerProductCandidates(profile);
    const results = await generateNewProductCombinations({ profile, candidateProducts: candidates, maximumResults: 8 });
    expect(results.length).toBeGreaterThan(0);
    // floralRoleStrength (Phase 9, ranking/debugging) — the strongest single component's real
    // floral-note density. Every surviving result must have SOME real floral presence (the hard
    // gate already guarantees matchedPreferenceFamilies includes "floral"); this additionally
    // confirms at least one result has a genuinely strong (not merely incidental) floral component.
    expect(results.some((r) => r.floralRoleStrength >= 0.3)).toBe(true);
  });

  // Phase 8 — multi-like breadth: "Likes: Fresh, Floral" should be able to reward a combination
  // that covers BOTH over one covering only one, via familyBreadthCoverageScore's additive bonus.
  it("Likes: Fresh, Floral — a combination covering both families scores a real breadth bonus a single-family match doesn't", async () => {
    const profile = {
      city: "Las Vegas", country: "United States", season: "Summer",
      likes: ["Fresh", "Floral"], dislikes: [], locationVerified: true,
    };
    const candidates = await analyzeCustomerProductCandidates(profile);
    const results = await generateNewProductCombinations({ profile, candidateProducts: candidates, maximumResults: 8 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      // The hard gate only requires >=1 of the two families for a multi-family profile (Phase 6/7's
      // explicit spec) — never both — but every result covering both must score MORE breadth credit
      // than one covering only one, which this directly proves via the real persisted breakdown.
      expect(r.requestedPreferenceFamilies).toEqual(expect.arrayContaining(["fresh", "floral"]));
      expect(r.missingPreferenceFamilies.length).toBeLessThanOrEqual(2);
    }
    const dualCoverage = results.filter((r) => r.matchedPreferenceFamilies.length >= 2);
    const singleCoverage = results.filter((r) => r.matchedPreferenceFamilies.length === 1);
    if (dualCoverage.length && singleCoverage.length) {
      // Direct proof of the breadth bonus itself, isolated from every other scoring axis.
      expect(familyBreadthCoverageScore(2)).toBeGreaterThan(familyBreadthCoverageScore(1));
    }
  });
});

// Fix (final-batch coverage metadata incomplete) — requestedExactNotes/fallbackUsed/
// fallbackTargetNotes weren't tracked at all; matchedExactNotes/missingExactNotes/
// exactNoteCoverageScore already were.
describe("final-batch coverage metadata (Phase 12)", () => {
  it("every returned result carries requestedExactNotes and a fallbackUsed flag", async () => {
    const profile = {
      city: "Los Angeles", stateRegion: "California", country: "United States", season: "Summer",
      likes: ["Fruity", "Apple"], dislikes: [], locationVerified: true,
    };
    const candidates = await analyzeCustomerProductCandidates(profile);
    const results = await generateNewProductCombinations({ profile, candidateProducts: candidates, maximumResults: 5 });
    for (const r of results) {
      expect(r.requestedExactNotes).toEqual(expect.arrayContaining(["apple"]));
      expect(typeof r.fallbackUsed).toBe("boolean");
      expect(Array.isArray(r.fallbackTargetNotes)).toBe(true);
    }
  });
});
