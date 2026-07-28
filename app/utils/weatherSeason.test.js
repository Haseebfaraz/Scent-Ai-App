import { describe, it, expect } from "vitest";
import {
  getCalendarSeason, describeWeatherSimple, deriveWeatherDirection,
  weatherDirectionToQuerySeason, hasSeasonWeatherConflict,
} from "./weatherSeason.js";

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

describe("deriveWeatherDirection", () => {
  it("returns 'rainy' regardless of temperature when the WMO code is a real precipitation code", () => {
    expect(deriveWeatherDirection(80, 63)).toBe("rainy");
  });

  it("returns 'humid' for a warm, high-humidity reading with no rain", () => {
    expect(deriveWeatherDirection(80, 0, 70)).toBe("humid");
  });

  it("does not call a cold, high-humidity day 'humid' — humidity only registers when it's warm", () => {
    expect(deriveWeatherDirection(45, 0, 90)).not.toBe("humid");
  });

  it("falls through the temperature bands correctly for a plain clear day", () => {
    expect(deriveWeatherDirection(95, 0)).toBe("hot");
    expect(deriveWeatherDirection(75, 0)).toBe("warm");
    expect(deriveWeatherDirection(60, 0)).toBe("mild");
    expect(deriveWeatherDirection(45, 0)).toBe("cool");
    expect(deriveWeatherDirection(20, 0)).toBe("cold");
  });
});

describe("weatherDirectionToQuerySeason", () => {
  it("maps hot/warm/humid to Summer and cold/cool to Winter for DB-query purposes only", () => {
    expect(weatherDirectionToQuerySeason("hot", "Spring")).toBe("Summer");
    expect(weatherDirectionToQuerySeason("humid", "Spring")).toBe("Summer");
    expect(weatherDirectionToQuerySeason("cold", "Spring")).toBe("Winter");
  });

  it("defers to the calendar fallback for an ambiguous direction", () => {
    expect(weatherDirectionToQuerySeason("mild", "Fall")).toBe("Fall");
    expect(weatherDirectionToQuerySeason(null, "Fall")).toBe("Fall");
  });
});

describe("hasSeasonWeatherConflict", () => {
  it("flags a requested Winter style against hot/warm/humid real conditions (the real transcript bug)", () => {
    expect(hasSeasonWeatherConflict("Winter", "hot")).toBe(true);
    expect(hasSeasonWeatherConflict("Winter", "warm")).toBe(true);
  });

  it("does not flag a requested Winter style against cool/cold/rainy conditions — that's not a conflict", () => {
    expect(hasSeasonWeatherConflict("Winter", "cool")).toBe(false);
    expect(hasSeasonWeatherConflict("Winter", "rainy")).toBe(false);
  });

  it("returns false when no style has been requested, or no weather reading exists yet", () => {
    expect(hasSeasonWeatherConflict(null, "hot")).toBe(false);
    expect(hasSeasonWeatherConflict("Winter", null)).toBe(false);
  });
});
