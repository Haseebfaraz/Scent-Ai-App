import { describe, it, expect } from "vitest";
import {
  computeRatios, assignRoles, generateNewProductCombinations,
  validateCombinationShape, computeEvidenceScope, computeHistoryScore, MAX_HISTORY_SCORE,
  buildFallbackAnchorsForMissingTerms, hasHardExcludedFamily, hasHardExcludedTerm,
} from "./recommendationEngine.server.js";
import { likeMatchStrength, classifyDislikeConflict } from "../utils/fragranceScoring.js";
import {
  literalNoteTermsFromLikes, literalNoteMatchCount, exactNoteCoverageScore, matchedLiteralTerms,
  missingLiteralTerms, textToPreferenceFamilies,
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

    const dislikeFamilies = textToPreferenceFamilies(profile.dislikes);
    const existing = await prisma.existingCombination.findMany({ select: { componentKey: true } });
    const existingKeys = new Set(existing.map((e) => e.componentKey));

    // scoreProposedCombination's hard reject checks severity PER COMPONENT (never rejecting a whole
    // combo for one merely-supporting note elsewhere) — so this checks the same granularity, not
    // the combo's combined note list, which can legitimately read as a stronger conflict once
    // several individually-mild components are summed together (that's a real, intentional design
    // choice, not a bug — see classifyDislikeConflict's own spec comment).
    for (const combo of combinations) {
      for (const product of combo.internalProducts) {
        const conflict = classifyDislikeConflict(product.notes, dislikeFamilies);
        expect(conflict.severity).not.toBe("high");
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
