import { describe, it, expect } from "vitest";
import { normalizeProductName, normalizeRegionText, resolveLocationInput, SEASON_ALIASES } from "./fragranceNormalization.js";

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

describe("SEASON_ALIASES", () => {
  it("covers all four seasons with their known raw-data label variants", () => {
    expect(SEASON_ALIASES.Winter).toContain("Winter Months");
    expect(SEASON_ALIASES.Fall).toContain("Autumn Months");
    expect(Object.keys(SEASON_ALIASES).sort()).toEqual(["Fall", "Spring", "Summer", "Winter"].sort());
  });
});
