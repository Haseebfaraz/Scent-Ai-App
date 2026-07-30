import { describe, it, expect } from "vitest";
import {
  normalizeProductName, normalizeRegionText, resolveLocationInput, SEASON_ALIASES,
  correctPreferenceVocabulary, correctPreferenceVocabularyList,
} from "./fragranceNormalization.js";

describe("normalizeProductName", () => {
  it("lowercases, trims, and strips punctuation", () => {
    expect(normalizeProductName("The Opera!")).toBe("the opera");
    expect(normalizeProductName("  Water   of   Arabia  ")).toBe("water of arabia");
  });

  it("returns an empty string for falsy input", () => {
    expect(normalizeProductName(null)).toBe("");
    expect(normalizeProductName(undefined)).toBe("");
    expect(normalizeProductName("")).toBe("");
  });
});

describe("normalizeRegionText", () => {
  it("lowercases and strips non-letters", () => {
    expect(normalizeRegionText("St. Clair Shores")).toBe("st clair shores");
    expect(normalizeRegionText("Côte d'Ivoire".replace("ô", "o"))).toBe("cote divoire");
  });
});

describe("resolveLocationInput", () => {
  const regionMaps = {
    city: new Map([["los angeles", "Los Angeles"]]),
    stateName: new Map([["california", "California"]]),
    countryName: new Map([["united states", "United States"]]),
  };

  it("resolves the acceptance-scenario known typos to real region data", () => {
    expect(resolveLocationInput("Los Angelos", regionMaps)).toMatchObject({
      resolved: true,
      field: "city",
      value: "Los Angeles",
      wasCorrected: true,
    });
    expect(resolveLocationInput("Califronia", regionMaps)).toMatchObject({
      resolved: true,
      field: "stateName",
      value: "California",
      wasCorrected: true,
    });
    expect(resolveLocationInput("United State", regionMaps)).toMatchObject({
      resolved: true,
      field: "countryName",
      value: "United States",
      wasCorrected: true,
    });
  });

  it("resolves an exact real match with no correction flagged", () => {
    expect(resolveLocationInput("Los Angeles", regionMaps)).toMatchObject({
      resolved: true,
      wasCorrected: false,
    });
  });

  it("flags an unrecognized location as needing confirmation rather than guessing", () => {
    expect(resolveLocationInput("Xyzzyville", regionMaps)).toMatchObject({
      resolved: false,
      needsConfirmation: true,
      value: null,
    });
  });

  it("returns not-resolved/no-confirmation-needed for empty input", () => {
    expect(resolveLocationInput("", regionMaps)).toMatchObject({ resolved: false, needsConfirmation: false });
    expect(resolveLocationInput(null, regionMaps)).toMatchObject({ resolved: false, needsConfirmation: false });
  });
});

describe("correctPreferenceVocabulary", () => {
  it("corrects the acceptance-scenario misspellings", () => {
    expect(correctPreferenceVocabulary("spricy").corrected).toBe("spicy");
    expect(correctPreferenceVocabulary("gourmant").corrected).toBe("gourmand");
    expect(correctPreferenceVocabulary("fruty").corrected).toBe("fruity");
    expect(correctPreferenceVocabulary("aquitic").corrected).toBe("aquatic");
  });

  it("corrects a misspelled word within a full sentence, leaving everything else untouched", () => {
    const result = correctPreferenceVocabulary("I like spricy and fruty scents for the gym");
    expect(result.corrected).toBe("I like spicy and fruity scents for the gym");
    expect(result.corrections).toEqual(
      expect.arrayContaining([
        { original: "spricy", corrected: "spicy" },
        { original: "fruty", corrected: "fruity" },
      ]),
    );
  });

  it("preserves capitalization pattern", () => {
    expect(correctPreferenceVocabulary("Spricy").corrected).toBe("Spicy");
    expect(correctPreferenceVocabulary("SPRICY").corrected).toBe("SPICY");
  });

  it("does not touch real words that aren't in the controlled list — no unrestricted fuzzy correction", () => {
    expect(correctPreferenceVocabulary("I like spicy and woody scents").corrected).toBe("I like spicy and woody scents");
    expect(correctPreferenceVocabulary("A totally unrelated sentence about cats").corrected).toBe("A totally unrelated sentence about cats");
  });

  it("never modifies a real product name (product names are not run through this corrector)", () => {
    // This function has no concept of a "product name" argument at all — normalizeProductName is
    // the only function that ever touches product titles, and it's untouched by this feature.
    expect(normalizeProductName("Fruty")).toBe("fruty"); // normalizeProductName never corrects spelling
  });

  it("returns no corrections and the original text for empty/non-string input", () => {
    expect(correctPreferenceVocabulary("")).toEqual({ corrected: "", corrections: [] });
    expect(correctPreferenceVocabulary(null)).toEqual({ corrected: "", corrections: [] });
  });
});

describe("correctPreferenceVocabularyList", () => {
  it("corrects each item in an array independently and combines corrections", () => {
    const result = correctPreferenceVocabularyList(["Spricy", "Woody", "Gourmant"]);
    expect(result.corrected).toEqual(["Spicy", "Woody", "Gourmand"]);
    expect(result.corrections).toEqual(
      expect.arrayContaining([
        { original: "Spricy", corrected: "spicy" },
        { original: "Gourmant", corrected: "gourmand" },
      ]),
    );
  });

  it("returns an empty result for an empty array", () => {
    expect(correctPreferenceVocabularyList([])).toEqual({ corrected: [], corrections: [] });
  });
});

describe("SEASON_ALIASES", () => {
  it("covers all four seasons with their known raw-data label variants", () => {
    expect(SEASON_ALIASES.Winter).toContain("Winter Months");
    expect(SEASON_ALIASES.Fall).toContain("Autumn Months");
    expect(Object.keys(SEASON_ALIASES).sort()).toEqual(["Fall", "Spring", "Summer", "Winter"].sort());
  });
});
