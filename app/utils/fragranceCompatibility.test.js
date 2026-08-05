import { describe, it, expect } from "vitest";
import {
  PREFERENCE_FAMILIES,
  COMPATIBILITY_TAGS,
  detectFamilies,
  pairIsCompatible,
  assessCombinationRisks,
  assessCombinationRiskDetails,
  groupAndPenalizeRisks,
  textToPreferenceFamilies,
  interpretCustomerPreferences,
  interpretLifestyleContext,
  computeComplexityLevel,
  passesIntensityFilter,
  countPreferredDirectionMatches,
  countAvoidedDirectionMatches,
  classifyAlmondCharacter,
  literalNoteTermsFromLikes,
  literalNoteMatchCount,
  exactNoteCoverageScore,
  matchedLiteralTerms,
  missingLiteralTerms,
  matchedRealNotesInText,
} from "./fragranceCompatibility.js";

describe("detectFamilies", () => {
  it("detects real product notes into the expected preference families", () => {
    expect(detectFamilies(["Mango", "Pineapple"], PREFERENCE_FAMILIES)).toContain("fruity");
    expect(detectFamilies(["Vanilla", "Sugar"], PREFERENCE_FAMILIES)).toContain("sweet");
    expect(detectFamilies(["Bergamot", "Lemon"], PREFERENCE_FAMILIES)).toContain("fresh");
    expect(detectFamilies(["Saffron", "Cinnamon"], PREFERENCE_FAMILIES)).toContain("spicy");
    expect(detectFamilies(["Oud", "Leather"], PREFERENCE_FAMILIES)).toContain("strongHeavy");
  });

  it("detects a generic catch-all note into its matching family", () => {
    expect(detectFamilies(["Fruity Notes"], PREFERENCE_FAMILIES)).toContain("fruity");
    expect(detectFamilies(["Spices"], PREFERENCE_FAMILIES)).toContain("spicy");
  });

  it("returns an empty array for notes matching no family", () => {
    expect(detectFamilies(["Zzznotarealnoteatall"], PREFERENCE_FAMILIES)).toEqual([]);
    expect(detectFamilies([], PREFERENCE_FAMILIES)).toEqual([]);
    expect(detectFamilies(null, PREFERENCE_FAMILIES)).toEqual([]);
  });
});

describe("textToPreferenceFamilies (customer free-text likes/dislikes)", () => {
  it("maps the acceptance-scenario words to the right families", () => {
    expect(textToPreferenceFamilies(["Fruity"])).toEqual(["fruity"]);
    expect(textToPreferenceFamilies(["Sweet"])).toEqual(["sweet"]);
    expect(textToPreferenceFamilies(["Spicy"])).toEqual(["spicy"]);
    expect(textToPreferenceFamilies(["Strong"])).toEqual(["strongHeavy"]);
  });

  // Fix (real customers say "candy", not "cotton candy") — confirmed live: a customer who said
  // "sweet and candy" and later "candy want some candy type also" got zero recognition for "candy"
  // specifically, since only the two-word spec phrase "cotton candy" was ever a keyword.
  it("recognizes bare 'candy', not just the two-word 'cotton candy' phrase", () => {
    expect(textToPreferenceFamilies(["candy"])).toEqual(["sweet"]);
    expect(textToPreferenceFamilies(["candy want some candy type also.."])).toEqual(["sweet"]);
  });

  // Fix (real customer named a real catalog note we didn't recognize) — confirmed live: "coconut"
  // is a real catalog note (shown in an actual Top Notes list), but a refinement saying "dont want
  // coconut" matched no family and no literal term at all, so it never persisted to the customer's
  // dislikes and never excluded coconut from the regenerated recommendation.
  it("recognizes 'coconut' as a fruity/tropical note", () => {
    expect(textToPreferenceFamilies(["coconut"])).toEqual(["fruity"]);
    expect(textToPreferenceFamilies(["dont want coconut"])).toEqual(["fruity"]);
  });
});

// Fix (literal note terms lost to family-level matching) — "Apple", "Strawberry", "Peach" used to
// all collapse into one `fruity` family tag, so a product matching via unrelated fruity notes
// scored identically to one containing the customer's actual named notes.
describe("literalNoteTermsFromLikes / literalNoteMatchCount", () => {
  it("extracts the specific note keywords a customer named, not the family descriptor itself", () => {
    const terms = literalNoteTermsFromLikes(["Fruity", "Fresh", "Apple", "Strawberry", "Peach"]);
    expect(terms).toEqual(expect.arrayContaining(["apple", "strawberry", "peach"]));
    expect(terms).not.toContain("fruity");
    expect(terms).not.toContain("fresh");
  });

  // Fix (refinement "dont want coconut" persisted nothing and excluded nothing) — coconut was
  // previously absent from every family, so it was invisible to both profile persistence and
  // refinement hard-exclusion.
  it("extracts 'coconut' as a literal note term", () => {
    const terms = literalNoteTermsFromLikes(["dont want coconut"]);
    expect(terms).toContain("coconut");
  });

  it("returns zero literal matches for a product that only shares the family, not the named note", () => {
    const terms = literalNoteTermsFromLikes(["Apple", "Strawberry", "Peach"]);
    expect(literalNoteMatchCount(["Pear", "Blackcurrant", "Musk"], terms)).toBe(0);
  });

  it("counts a real literal match against a product genuinely containing the named note", () => {
    const terms = literalNoteTermsFromLikes(["Apple", "Strawberry", "Peach"]);
    expect(literalNoteMatchCount(["Peach", "Musk", "Vanilla"], terms)).toBe(1);
    expect(literalNoteMatchCount(["Apple", "Peach", "Vanilla"], terms)).toBe(2);
  });

  // Fix (Pineapple counted as Apple) — real bug found in a targeted audit: plain substring matching
  // treated "apple" as present inside "pineapple". Word-boundary matching fixes both directions.
  it("never lets Pineapple count as a match for a customer who named Apple", () => {
    const terms = literalNoteTermsFromLikes(["Apple"]);
    expect(literalNoteMatchCount(["Pineapple Slice"], terms)).toBe(0);
    expect(literalNoteMatchCount(["Pink Lady Apple"], terms)).toBe(1);
  });

  it("never lets a customer who named Pineapple also register the shorter 'apple' fragment inside it", () => {
    const terms = literalNoteTermsFromLikes(["Pineapple"]);
    expect(terms).toContain("pineapple");
    expect(terms).not.toContain("apple");
    expect(literalNoteMatchCount(["Pink Lady Apple"], terms)).toBe(0);
  });

  // Explicitly requested regression: Pear must never count as a match for Peach, and vice versa —
  // confirmed still correct after the word-boundary fix (no substring relationship between them).
  it("never lets Pear count as a match for Peach, or Peach count as a match for Pear", () => {
    const peachTerms = literalNoteTermsFromLikes(["Peach"]);
    expect(literalNoteMatchCount(["Pear"], peachTerms)).toBe(0);
    const pearTerms = literalNoteTermsFromLikes(["Pear"]);
    expect(literalNoteMatchCount(["Peach"], pearTerms)).toBe(0);
  });

  // Fix ("berr" catch-all counted as Strawberry) — the fruity family's own generic fragment for
  // catching Raspberry/Blackberry/etc under the spec's "berries" example is real and useful for
  // FAMILY detection, but was also leaking into literal-term extraction, letting any berry note
  // count as a match for a customer who specifically named Strawberry.
  it("never lets a generic berry note count as a match for a customer who named Strawberry specifically", () => {
    const terms = literalNoteTermsFromLikes(["Strawberry"]);
    expect(terms).not.toContain("berr");
    expect(literalNoteMatchCount(["Raspberry", "Blackberry", "Blueberry"], terms)).toBe(0);
    expect(literalNoteMatchCount(["Strawberry Purée"], terms)).toBe(1);
  });

  // Same word-boundary fix, different family — "wood" is a real fruity/woody keyword, but it's also
  // a suffix hiding inside "Sandalwood"; a customer who names plain "Wood" must not match it.
  it("never lets Sandalwood count as a match for a customer who named plain Wood", () => {
    const terms = literalNoteTermsFromLikes(["Wood"]);
    expect(literalNoteMatchCount(["Sandalwood"], terms)).toBe(0);
    expect(literalNoteMatchCount(["Aged Wood Accord"], terms)).toBe(1);
  });
});

// Fix (refinement could only recognize notes already in the curated PREFERENCE_FAMILIES vocabulary)
// — confirmed live: "dont want coconut" was a silent no-op until "coconut" was hand-added to a
// family list, and the same gap recurs for any real note not yet in the vocabulary. Checking
// directly against the SPECIFIC real notes of whatever recommendation is on screen closes that gap
// for any note, without needing to enumerate the whole catalog's vocabulary up front.
describe("matchedRealNotesInText", () => {
  it("recognizes a real note by name even though it belongs to no PREFERENCE_FAMILIES entry at all", () => {
    expect(textToPreferenceFamilies(["Jackfruit"])).toEqual([]); // confirms the gap this closes
    expect(matchedRealNotesInText("dont want jackfruit", ["Gin", "Mojito", "Jackfruit"])).toEqual(["jackfruit"]);
  });

  it("only matches notes that are actually in the given list, not any word in the text", () => {
    expect(matchedRealNotesInText("dont want jackfruit", ["Gin", "Mojito", "Coconut"])).toEqual([]);
  });

  it("matches a multi-word note as a whole phrase", () => {
    expect(matchedRealNotesInText("remove the griotte syrup please", ["Black Cherry", "Griotte Syrup"])).toEqual(["griotte syrup"]);
  });

  it("never lets a shorter note falsely match inside a longer unrelated word", () => {
    expect(matchedRealNotesInText("pineapple please", ["Apple"])).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(matchedRealNotesInText("", ["Coconut"])).toEqual([]);
    expect(matchedRealNotesInText("dont want coconut", [])).toEqual([]);
    expect(matchedRealNotesInText("dont want coconut", null)).toEqual([]);
  });
});

// Fix (tiered exact-note coverage scoring) — a flat per-match boost treated a customer's 1st and
// 4th named note as equally significant; a diminishing tier rewards breadth of coverage without
// letting it run away unbounded.
describe("exactNoteCoverageScore", () => {
  it("scores zero matches as zero", () => {
    expect(exactNoteCoverageScore(0)).toBe(0);
  });

  it("scores the first three distinct matches at 10, then 7, then 5", () => {
    expect(exactNoteCoverageScore(1)).toBe(10);
    expect(exactNoteCoverageScore(2)).toBe(10 + 7);
    expect(exactNoteCoverageScore(3)).toBe(10 + 7 + 5);
  });

  it("floors every match beyond the third at the same +5 tier value, never zero or negative", () => {
    expect(exactNoteCoverageScore(4)).toBe(10 + 7 + 5 + 5);
    expect(exactNoteCoverageScore(5)).toBe(10 + 7 + 5 + 5 + 5);
  });

  // Always bigger than the flat family-level bonus (SCORE_WEIGHTS.matchesLike = 5 per matched
  // family) even at a single match — the explicit requirement that broad family matching stay the
  // smaller score.
  it("even a single exact match outweighs the flat family-match bonus of 5", () => {
    expect(exactNoteCoverageScore(1)).toBeGreaterThan(5);
  });
});

// Fix (final-batch preference coverage) — literalNoteMatchCount only returns a COUNT; these return
// WHICH specific terms matched or didn't, needed to check batch-wide coverage of every named note.
describe("matchedLiteralTerms / missingLiteralTerms", () => {
  it("splits a customer's named notes into matched vs. missing against a product's real notes", () => {
    const terms = literalNoteTermsFromLikes(["Apple", "Strawberry", "Peach"]);
    const notes = ["Peach Purée", "Musk", "Vanilla"];
    expect(matchedLiteralTerms(notes, terms)).toEqual(["peach"]);
    expect(missingLiteralTerms(notes, terms)).toEqual(expect.arrayContaining(["apple", "strawberry"]));
    expect(missingLiteralTerms(notes, terms)).not.toContain("peach");
  });

  it("reports everything missing when nothing matches at all", () => {
    const terms = literalNoteTermsFromLikes(["Apple", "Strawberry"]);
    expect(matchedLiteralTerms(["Musk", "Cedar"], terms)).toEqual([]);
    expect(missingLiteralTerms(["Musk", "Cedar"], terms)).toEqual(expect.arrayContaining(["apple", "strawberry"]));
  });

  it("reports nothing missing when every named term is covered", () => {
    const terms = literalNoteTermsFromLikes(["Apple", "Peach"]);
    const notes = ["Apple Sauce", "Peach Purée"];
    expect(missingLiteralTerms(notes, terms)).toEqual([]);
    expect(matchedLiteralTerms(notes, terms)).toHaveLength(2);
  });
});

describe("pairIsCompatible", () => {
  it("confirms spec-listed compatible pairs", () => {
    expect(pairIsCompatible("fruity", "citrus")).toBe(true);
    expect(pairIsCompatible("citrus", "fruity")).toBe(true); // order-independent
    expect(pairIsCompatible("smoky", "amber")).toBe(true);
    expect(pairIsCompatible("woody", "amber")).toBe(true);
  });

  it("rejects pairs never listed as compatible", () => {
    expect(pairIsCompatible("spicy", "musk")).toBe(false);
    expect(pairIsCompatible("strongHeavy", "fruity")).toBe(false);
  });
});

describe("assessCombinationRisks", () => {
  it("flags excessive gourmand notes only when the season is Summer", () => {
    const products = [
      { title: "A", notes: ["Sugar", "Caramel"] },
      { title: "B", notes: ["Marshmallow", "Honey"] },
    ];
    expect(assessCombinationRisks(products, { season: "Summer" }).some((r) => r.includes("summer heat"))).toBe(true);
    expect(assessCombinationRisks(products, { season: "Winter" }).some((r) => r.includes("summer heat"))).toBe(false);
  });

  it("flags multiple heavy components", () => {
    const products = [
      { title: "A", notes: ["Oud", "Leather"] },
      { title: "B", notes: ["Tobacco", "Resin"] },
    ];
    expect(assessCombinationRisks(products).some((r) => r.includes("heavy oud/leather"))).toBe(true);
  });

  it("flags too many competing fruity products", () => {
    const products = [
      { title: "A", notes: ["Mango"] },
      { title: "B", notes: ["Pineapple"] },
      { title: "C", notes: ["Peach"] },
    ];
    expect(assessCombinationRisks(products).some((r) => r.includes("fruity products may compete"))).toBe(true);
  });

  it("flags Quadbrid-level complexity at 4+ products", () => {
    const products = [
      { title: "A", notes: ["Vanilla"] },
      { title: "B", notes: ["Musk"] },
      { title: "C", notes: ["Cedar"] },
      { title: "D", notes: ["Amber"] },
    ];
    expect(assessCombinationRisks(products).some((r) => r.includes("Four products"))).toBe(true);
  });

  it("flags a duplicate single-direction combination with no contrast", () => {
    const products = [
      { title: "A", notes: ["Mango"] },
      { title: "B", notes: ["Pineapple"] },
    ];
    expect(assessCombinationRisks(products).some((r) => r.includes("no contrasting role"))).toBe(true);
  });

  it("returns no risks for a small, genuinely balanced combination", () => {
    const products = [
      { title: "A", notes: ["Bergamot", "Lemon"] },
      { title: "B", notes: ["Musk", "Cedar"] },
    ];
    expect(assessCombinationRisks(products, { season: "Winter" })).toEqual([]);
  });
});

// Fix (flat risk-count penalty replaced with severity) — every risk used to cost a flat -10
// regardless of how minor or serious it actually was, and a Tribrid/Quadbrid mechanically racks up
// more hits than a Hybrid just from having more components, unrelated to real fit.
describe("assessCombinationRiskDetails (severity-weighted, correlation-grouped)", () => {
  it("weights a single advisory-severity risk far lighter than the old flat -10", () => {
    const products = [
      { title: "A", notes: ["Bergamot"] }, // fresh
      { title: "B", notes: ["Vanilla"] }, // sweet
      { title: "C", notes: ["Cedar"] }, // woody
      { title: "D", notes: ["Musk"] }, // musk
    ];
    const result = assessCombinationRiskDetails(products);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0]).toMatchObject({ id: "quadbrid_complexity", severity: "advisory", counted: true, penalty: -1 });
    expect(result.riskPenalty).toBe(-1);
    expect(result.hasCritical).toBe(false);
  });

  it("weights the high-severity duplicate_direction risk at -10", () => {
    const products = [
      { title: "A", notes: ["Mango"] },
      { title: "B", notes: ["Pineapple"] },
    ];
    const result = assessCombinationRiskDetails(products);
    expect(result.breakdown).toEqual([
      expect.objectContaining({ id: "duplicate_direction", severity: "high", counted: true, penalty: -10 }),
    ]);
    expect(result.riskPenalty).toBe(-10);
  });

  // Correlated-risk deduplication: three all-fruity products trip BOTH competing_fruits (low, -2)
  // AND duplicate_direction (high, -10) for the exact same underlying problem (nothing but fruity
  // anywhere) — only the higher-severity hit should count toward the total, once.
  it("groups competing_fruits and duplicate_direction for the same family, counting only the higher severity once", () => {
    const products = [
      { title: "A", notes: ["Mango"] },
      { title: "B", notes: ["Pineapple"] },
      { title: "C", notes: ["Guava"] },
    ];
    const result = assessCombinationRiskDetails(products);
    expect(result.breakdown).toHaveLength(2);
    const duplicate = result.breakdown.find((r) => r.id === "duplicate_direction");
    const competing = result.breakdown.find((r) => r.id === "competing_fruits");
    expect(duplicate).toMatchObject({ severity: "high", counted: true, penalty: -10 });
    expect(competing).toMatchObject({ severity: "low", counted: false, penalty: 0 });
    // Not -10 + -2 = -12 — the same real problem, counted once.
    expect(result.riskPenalty).toBe(-10);
  });
});

describe("groupAndPenalizeRisks (pure grouping/penalty function)", () => {
  it("counts every uncorrelated hit independently", () => {
    const result = groupAndPenalizeRisks([
      { id: "a", message: "a", severity: "advisory" },
      { id: "b", message: "b", severity: "low" },
    ]);
    expect(result.riskPenalty).toBe(-1 + -2);
    expect(result.breakdown.every((r) => r.counted)).toBe(true);
  });

  it("only counts the highest-severity hit within a correlated group", () => {
    const result = groupAndPenalizeRisks(
      [
        { id: "a", message: "a", severity: "low" },
        { id: "b", message: "b", severity: "high" },
      ],
      () => "same-group",
    );
    expect(result.riskPenalty).toBe(-10);
    expect(result.breakdown.find((r) => r.id === "a")).toMatchObject({ counted: false, penalty: 0 });
    expect(result.breakdown.find((r) => r.id === "b")).toMatchObject({ counted: true, penalty: -10 });
  });

  // No current real rule uses "critical" — this proves the hard-reject mechanism itself works,
  // independent of whether any production rule has reached for it yet.
  it("flags hasCritical when any hit is critical severity, regardless of grouping", () => {
    const result = groupAndPenalizeRisks([{ id: "x", message: "x", severity: "critical" }]);
    expect(result.hasCritical).toBe(true);
  });

  it("never flags hasCritical when nothing is critical", () => {
    const result = groupAndPenalizeRisks([{ id: "x", message: "x", severity: "high" }]);
    expect(result.hasCritical).toBe(false);
  });
});

// Required Test 1 (Aniq spec) — natural-language sensitivity mapping.
describe("interpretCustomerPreferences (Test 1: natural-language sensitivity mapping)", () => {
  it("maps the exact Aniq complaint to high sensitivity, light strength, simple Hybrids", () => {
    const profile = {
      dislikes: ["I do not like scents that hit my nose and make me feel headache."],
      additionalPreferences: ["I do not like scents that hit my nose and make me feel headache."],
      preferredStyle: "Relaxing",
    };
    const result = interpretCustomerPreferences(profile);
    expect(result.sensitivityLevel).toBe("high");
    expect(result.strengthPreference).toBe("light");
    expect(result.preferSimpleCombinations).toBe(true);
    expect(result.preferredCombinationTypes).toEqual(["HYBRID"]);
    expect(result.preferredDirections).toEqual(
      expect.arrayContaining(["relaxing", "airy", "clean", "watery", "green-tea", "soft-musky", "light-fruity"]),
    );
    expect(result.avoidedDirections).toEqual(
      expect.arrayContaining(["sharp", "piercing", "pepper-heavy", "dense-spicy", "smoky", "heavy-amber", "oud", "leather", "tobacco"]),
    );
  });

  it("recognizes informal/misspelled sensitivity phrasing", () => {
    expect(interpretCustomerPreferences({ dislikes: ["it feels too haddik on me"] }).sensitivityLevel).toBe("high");
    expect(interpretCustomerPreferences({ dislikes: ["gives me a headache"] }).sensitivityLevel).toBe("high");
    expect(interpretCustomerPreferences({ dislikes: ["it's overpowering and suffocating"] }).sensitivityLevel).toBe("high");
    expect(interpretCustomerPreferences({ dislikes: ["I cannot tolerate strong perfume"] }).sensitivityLevel).toBe("high");
  });

  // Fix (real customers say "strong scents", not "too strong") — confirmed live: a customer whose
  // ONLY stated dislike was "strong scents" produced zero sensitivity signal at all (only the
  // narrower "too strong" phrasing was recognized before), so a QUADBRID with 40+ combined notes
  // still won despite the customer explicitly saying the opposite of what they wanted.
  it("recognizes 'strong scent(s)/perfume/fragrance' as its own sensitivity phrasing, not just 'too strong'", () => {
    expect(interpretCustomerPreferences({ dislikes: ["oud", "strong scents"] }).sensitivityLevel).toBe("high");
    expect(interpretCustomerPreferences({ dislikes: ["strong perfume"] }).sensitivityLevel).toBe("high");
    expect(interpretCustomerPreferences({ dislikes: ["strong fragrance"] }).sensitivityLevel).toBe("high");
  });

  it("never flags a merely strong PREFERENCE (unrelated to scent intensity) as a sensitivity signal", () => {
    expect(interpretCustomerPreferences({ dislikes: ["I have a strong preference for citrus"] }).sensitivityLevel).toBe("none");
  });

  it("does not flag sensitivity for an unrelated dislike", () => {
    expect(interpretCustomerPreferences({ dislikes: ["I don't like vanilla"] }).sensitivityLevel).toBe("none");
  });
});

describe("computeComplexityLevel (Aniq spec complexity bands)", () => {
  it("matches the exact spec thresholds", () => {
    expect(computeComplexityLevel(3)).toBe("low");
    expect(computeComplexityLevel(6)).toBe("low");
    expect(computeComplexityLevel(7)).toBe("moderate");
    expect(computeComplexityLevel(12)).toBe("moderate");
    expect(computeComplexityLevel(13)).toBe("high");
    expect(computeComplexityLevel(20)).toBe("high");
    expect(computeComplexityLevel(21)).toBe("very-high");
    expect(computeComplexityLevel(27)).toBe("very-high"); // real note count for "Ti Amo Mi Amor"
  });
});

describe("passesIntensityFilter (hard pre-generation sensitivity filter)", () => {
  it("excludes a product with 3+ real intensity-driver notes for a high-sensitivity customer", () => {
    const intent = { sensitivityLevel: "high" };
    expect(passesIntensityFilter(["Black Pepper", "Saffron", "Cinnamon", "Bergamot"], intent)).toBe(false);
  });

  it("does not exclude a product with only one strong note — never a blanket ban on a single note", () => {
    const intent = { sensitivityLevel: "high" };
    expect(passesIntensityFilter(["Black Pepper", "Bergamot", "Lavender"], intent)).toBe(true);
  });

  it("excludes very-high complexity (21+ notes) regardless of intensity-driver count", () => {
    const intent = { sensitivityLevel: "high" };
    const manyMildNotes = Array.from({ length: 22 }, (_, i) => `Mild Note ${i}`);
    expect(passesIntensityFilter(manyMildNotes, intent)).toBe(false);
  });

  it("never filters when the customer has no high sensitivity", () => {
    expect(passesIntensityFilter(["Black Pepper", "Saffron", "Cinnamon", "Oud"], { sensitivityLevel: "none" })).toBe(true);
    expect(passesIntensityFilter(["Black Pepper", "Saffron", "Cinnamon", "Oud"], null)).toBe(true);
  });
});

describe("powdery family and almond context", () => {
  it("detects real orris/iris/violet/heliotrope/powder notes as the powdery family", () => {
    expect(detectFamilies(["Orris"], PREFERENCE_FAMILIES)).toContain("powdery");
    expect(detectFamilies(["Iris", "Violet"], PREFERENCE_FAMILIES)).toContain("powdery");
    expect(detectFamilies(["Heliotrope"], PREFERENCE_FAMILIES)).toContain("powdery");
  });

  it("a customer stating a like/dislike of 'powdery' maps to the powdery family", () => {
    expect(textToPreferenceFamilies(["Powdery"])).toEqual(["powdery"]);
  });

  it("classifyAlmondCharacter: almond alone reads as nutty by default", () => {
    expect(classifyAlmondCharacter(["Almond", "Bergamot"])).toBe("nutty");
  });

  it("classifyAlmondCharacter: almond with orris/iris/violet/heliotrope reads as powdery", () => {
    expect(classifyAlmondCharacter(["Almond", "Iris"])).toBe("powdery");
    expect(classifyAlmondCharacter(["Almond", "Orris"])).toBe("powdery");
  });

  it("classifyAlmondCharacter: almond with vanilla/tonka/caramel/honey reads as gourmand", () => {
    expect(classifyAlmondCharacter(["Almond", "Vanilla"])).toBe("gourmand");
    expect(classifyAlmondCharacter(["Almond", "Tonka Bean"])).toBe("gourmand");
  });

  it("classifyAlmondCharacter: returns null when there's no almond at all", () => {
    expect(classifyAlmondCharacter(["Bergamot", "Musk"])).toBeNull();
  });

  it("a pure-almond-only product never counts toward powdery family detection on its own", () => {
    // Confirms the family keyword list deliberately excludes "almond" — see fragranceCompatibility.js.
    expect(detectFamilies(["Almond"], PREFERENCE_FAMILIES)).not.toContain("powdery");
  });
});

describe("assessCombinationRisks: powdery overload", () => {
  it("flags 2+ powdery products", () => {
    const products = [
      { title: "A", notes: ["Orris", "Bergamot"] },
      { title: "B", notes: ["Iris", "Musk"] },
    ];
    expect(assessCombinationRisks(products).some((r) => r.includes("powdery"))).toBe(true);
  });

  it("does not flag a single powdery product", () => {
    const products = [
      { title: "A", notes: ["Orris", "Bergamot"] },
      { title: "B", notes: ["Vanilla", "Musk"] },
    ];
    expect(assessCombinationRisks(products).some((r) => r.includes("powdery"))).toBe(false);
  });
});

describe("interpretLifestyleContext", () => {
  it("recognizes a gym/workout context", () => {
    const result = interpretLifestyleContext({ occasion: "for the gym, working out most mornings" });
    expect(result.lifestyles).toContain("gym");
    expect([...result.preferredDirections.keys()]).toEqual(expect.arrayContaining(["airy", "crisp"]));
  });

  it("recognizes a relaxation/unwind context", () => {
    const result = interpretLifestyleContext({ occasion: "just want to relax and unwind at home" });
    expect(result.lifestyles).toContain("relaxation");
    expect([...result.preferredDirections.keys()]).toEqual(expect.arrayContaining(["relaxing"]));
  });

  it("treats 'safety officer' as a professional/workplace context", () => {
    const result = interpretLifestyleContext({ occasion: "I work as a safety officer" });
    expect(result.lifestyles).toContain("office");
  });

  it("supports multiple simultaneous lifestyles via weighted intersection (office + gym + unwind)", () => {
    const result = interpretLifestyleContext({ occasion: "I work in an office, hit the gym after work, then like to unwind in the evening" });
    expect(result.lifestyles).toEqual(expect.arrayContaining(["office", "gym", "relaxation"]));
    // Each matched lifestyle's directions are weighted by 1/matchCount — with 3 lifestyles matched,
    // no single one should carry the full weight of 1.
    for (const weight of result.preferredDirections.values()) {
      expect(weight).toBeLessThanOrEqual(1);
      expect(weight).toBeGreaterThan(0);
    }
  });

  it("returns empty results when no lifestyle is mentioned at all", () => {
    const result = interpretLifestyleContext({ occasion: "just want something nice" });
    expect(result.lifestyles).toEqual([]);
    expect(result.preferredDirections.size).toBe(0);
  });
});

describe("countPreferredDirectionMatches / countAvoidedDirectionMatches (Test 2 mechanism)", () => {
  it("counts a relaxing-style product's real notes against preferredDirections", () => {
    expect(countPreferredDirectionMatches(["Lavender", "Musk", "Chamomile"], ["relaxing"])).toBeGreaterThan(0);
  });

  it("counts a pepper-heavy product's real notes against avoidedDirections", () => {
    expect(countAvoidedDirectionMatches(["Black Pepper", "Saffron"], ["pepper-heavy", "dense-spicy"])).toBeGreaterThan(0);
  });

  it("never penalizes a direction the customer didn't actually avoid", () => {
    expect(countAvoidedDirectionMatches(["Black Pepper"], ["oud", "leather"])).toBe(0);
  });
});
