import { describe, it, expect } from "vitest";
import {
  PREFERENCE_FAMILIES,
  COMPATIBILITY_TAGS,
  detectFamilies,
  pairIsCompatible,
  assessCombinationRisks,
  textToPreferenceFamilies,
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
