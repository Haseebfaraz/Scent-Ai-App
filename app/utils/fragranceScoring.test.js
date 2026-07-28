import { describe, it, expect } from "vitest";
import { SCORE_WEIGHTS, classifyDislikeConflict, matchedLikes, computeEvidenceLevel } from "./fragranceScoring.js";

describe("SCORE_WEIGHTS", () => {
  it("matches the spec's exact Phase 3 point values", () => {
    expect(SCORE_WEIGHTS.sameCity).toBe(5);
    expect(SCORE_WEIGHTS.sameCountry).toBe(4);
    expect(SCORE_WEIGHTS.sameStateRegionOrClimate).toBe(3);
    expect(SCORE_WEIGHTS.sameSeason).toBe(4);
    expect(SCORE_WEIGHTS.matchesLike).toBe(5);
    expect(SCORE_WEIGHTS.conflictsDislike).toBe(-10);
    expect(SCORE_WEIGHTS.repeatPurchaseBySimilarCustomer).toBe(3);
    expect(SCORE_WEIGHTS.popularAmongSimilarCustomers).toBe(2);
  });
});

describe("classifyDislikeConflict", () => {
  it("returns none when no disliked family is present", () => {
    const result = classifyDislikeConflict(["Bergamot", "Musk"], ["spicy"]);
    expect(result).toMatchObject({ severity: "none", matchedFamilies: [], matchedNoteCount: 0 });
  });

  it("returns low for a single non-prominent conflicting note", () => {
    const notes = ["Vanilla", "Sugar", "Marshmallow", "Honey", "Tonka", "Oud"];
    const result = classifyDislikeConflict(notes, ["strongHeavy"]);
    expect(result.severity).toBe("low");
    expect(result.matchedFamilies).toEqual(["strongHeavy"]);
  });

  it("returns medium for a single conflicting note among the first few (prominent)", () => {
    const notes = ["Oud", "Sugar", "Marshmallow"];
    const result = classifyDislikeConflict(notes, ["strongHeavy"]);
    expect(result.severity).toBe("medium");
  });

  it("returns high for multiple conflicting notes, and high conflicts should be excluded", () => {
    const notes = ["Oud", "Leather", "Tobacco", "Vanilla"];
    const result = classifyDislikeConflict(notes, ["strongHeavy"]);
    expect(result.severity).toBe("high");
  });

  it("does not automatically reject for one minor supporting note (spec requirement)", () => {
    const notes = ["Vanilla", "Sugar", "Marshmallow", "Honey", "Tonka", "Musk", "Amber"];
    const result = classifyDislikeConflict(notes, ["strongHeavy"]);
    expect(result.severity).not.toBe("high");
  });
});

describe("matchedLikes", () => {
  it("returns only families genuinely present in the product's real notes", () => {
    const notes = ["Mango", "Vanilla", "Bergamot"];
    expect(matchedLikes(notes, ["fruity", "sweet", "spicy"]).sort()).toEqual(["fruity", "sweet"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(matchedLikes(["Oud", "Leather"], ["fruity", "sweet"])).toEqual([]);
  });
});

describe("computeEvidenceLevel", () => {
  it("returns high for strong evidence", () => {
    expect(computeEvidenceLevel({ distinctSimilarCustomers: 12, sameSeasonOrders: 0 })).toBe("high");
    expect(computeEvidenceLevel({ distinctSimilarCustomers: 0, sameSeasonOrders: 30 })).toBe("high");
  });

  it("returns medium for moderate evidence", () => {
    expect(computeEvidenceLevel({ distinctSimilarCustomers: 4, sameSeasonOrders: 0 })).toBe("medium");
  });

  it("returns low for thin or no evidence", () => {
    expect(computeEvidenceLevel({})).toBe("low");
    expect(computeEvidenceLevel({ distinctSimilarCustomers: 1, sameSeasonOrders: 2 })).toBe("low");
  });
});
