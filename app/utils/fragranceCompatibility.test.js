import { describe, it, expect } from "vitest";
import {
  PREFERENCE_FAMILIES,
  COMPATIBILITY_TAGS,
  detectFamilies,
  pairIsCompatible,
  assessCombinationRisks,
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

  it("returns zero literal matches for a product that only shares the family, not the named note", () => {
    const terms = literalNoteTermsFromLikes(["Apple", "Strawberry", "Peach"]);
    expect(literalNoteMatchCount(["Pear", "Blackcurrant", "Musk"], terms)).toBe(0);
  });

  it("counts a real literal match against a product genuinely containing the named note", () => {
    const terms = literalNoteTermsFromLikes(["Apple", "Strawberry", "Peach"]);
    expect(literalNoteMatchCount(["Peach", "Musk", "Vanilla"], terms)).toBe(1);
    expect(literalNoteMatchCount(["Apple", "Peach", "Vanilla"], terms)).toBe(2);
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
