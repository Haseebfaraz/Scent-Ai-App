import { describe, it, expect } from "vitest";
import { parseRecommendationSelection } from "./recommendationSelectionParser.js";

const activeList = [{ recommendationId: "rec_1" }, { recommendationId: "rec_2" }, { recommendationId: "rec_3" }];

describe("parseRecommendationSelection", () => {
  it("resolves a plain digit", () => {
    expect(parseRecommendationSelection("1", activeList)).toEqual({ recommendationId: "rec_1" });
  });

  it("resolves 'Option 1'", () => {
    expect(parseRecommendationSelection("Option 1", activeList)).toEqual({ recommendationId: "rec_1" });
  });

  it("resolves 'opt 1 is good'", () => {
    expect(parseRecommendationSelection("opt 1 is good", activeList)).toEqual({ recommendationId: "rec_1" });
  });

  it("resolves the real transcript typo 'opt 1 is goof'", () => {
    expect(parseRecommendationSelection("opt 1 is goof", activeList)).toEqual({ recommendationId: "rec_1" });
  });

  it("resolves written numbers ('option two')", () => {
    expect(parseRecommendationSelection("I'll take option two", activeList)).toEqual({ recommendationId: "rec_2" });
  });

  it("resolves ordinals ('the first one', 'second', 'last')", () => {
    expect(parseRecommendationSelection("the first one please", activeList)).toEqual({ recommendationId: "rec_1" });
    expect(parseRecommendationSelection("give me the second", activeList)).toEqual({ recommendationId: "rec_2" });
    expect(parseRecommendationSelection("I want the last one", activeList)).toEqual({ recommendationId: "rec_3" });
  });

  it("resolves common selection phrases ('go with', 'create this', 'choose 3')", () => {
    expect(parseRecommendationSelection("let's go with number 3", activeList)).toEqual({ recommendationId: "rec_3" });
    expect(parseRecommendationSelection("choose 1", activeList)).toEqual({ recommendationId: "rec_1" });
  });

  it("returns noMatch for an out-of-range rank", () => {
    expect(parseRecommendationSelection("option 9", activeList)).toEqual({ noMatch: true });
  });

  it("returns noMatch for genuinely unrelated text", () => {
    expect(parseRecommendationSelection("what's the weather like", activeList)).toEqual({ noMatch: true });
  });

  it("resolves a bare affirmation when only one recommendation is active", () => {
    expect(parseRecommendationSelection("this one is fine, create it", [{ recommendationId: "only_one" }])).toEqual({
      recommendationId: "only_one",
    });
  });

  it("returns noMatch (never resolves a guess) when the list is empty", () => {
    expect(parseRecommendationSelection("option 1", [])).toEqual({ noMatch: true });
  });
});
