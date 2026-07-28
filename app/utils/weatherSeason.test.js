import { describe, it, expect } from "vitest";
import { getCalendarSeason, describeWeatherSimple, hasSeasonWeatherConflict } from "./weatherSeason.js";

describe("getCalendarSeason", () => {
  it("never throws and returns one of the four real seasons regardless of hemisphere", () => {
    for (const country of [null, "United States", "Australia", "Chile"]) {
      expect(["Winter", "Spring", "Summer", "Fall"]).toContain(getCalendarSeason(country));
    }
  });

  it("flips north/south for an explicitly-listed southern-hemisphere country", () => {
    const northern = getCalendarSeason("United States");
    const southern = getCalendarSeason("Australia");
    const FLIP = { Winter: "Summer", Summer: "Winter", Spring: "Fall", Fall: "Spring" };
    expect(southern).toBe(FLIP[northern]);
  });
});

describe("describeWeatherSimple", () => {
  it("never states an exact temperature — only simple words", () => {
    const { words, summary } = describeWeatherSimple(95, 0);
    expect(words).toContain("hot");
    expect(words).toContain("sunny");
    expect(summary).not.toMatch(/\d/);
  });

  it("maps a rainy WMO code and cool temperature to plain words", () => {
    const { words } = describeWeatherSimple(50, 63);
    expect(words).toContain("cool");
    expect(words).toContain("rainy");
  });
});

describe("hasSeasonWeatherConflict", () => {
  it("flags hot/sunny weather against a stated Winter (the real transcript bug)", () => {
    expect(hasSeasonWeatherConflict("Winter", ["hot", "sunny"])).toBe(true);
  });

  it("does not flag rainy/cool weather against a stated Winter — that's not a conflict", () => {
    expect(hasSeasonWeatherConflict("Winter", ["cool", "rainy"])).toBe(false);
  });

  it("returns false when no season is stated yet", () => {
    expect(hasSeasonWeatherConflict(null, ["hot", "sunny"])).toBe(false);
  });
});
