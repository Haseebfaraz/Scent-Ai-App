import { describe, it, expect } from "vitest";
import { DIRECTION_VOCABULARY, directionForRole, pickWords, describeCharacter } from "./fragranceVocabulary.js";

describe("directionForRole", () => {
  it("maps light/fruity roles to light_energetic and base/longevity roles to deep_evening", () => {
    expect(directionForRole("Freshness")).toBe("light_energetic");
    expect(directionForRole("Main fruit body")).toBe("light_energetic");
    expect(directionForRole("Musk/wood base")).toBe("deep_evening");
    expect(directionForRole("Longevity support")).toBe("deep_evening");
  });

  it("falls back to smooth_professional for an unrecognized role", () => {
    expect(directionForRole("NotARealRole")).toBe("smooth_professional");
  });
});

describe("pickWords", () => {
  it("is deterministic — the same seed always returns the same words", () => {
    const a = pickWords(DIRECTION_VOCABULARY.light_energetic, 2, "combo-abc");
    const b = pickWords(DIRECTION_VOCABULARY.light_energetic, 2, "combo-abc");
    expect(a).toEqual(b);
  });

  it("never repeats a word already in the shared usedWords set across a batch", () => {
    const usedWords = new Set();
    const first = pickWords(DIRECTION_VOCABULARY.light_energetic, 2, "seed-1", usedWords);
    const second = pickWords(DIRECTION_VOCABULARY.light_energetic, 2, "seed-2", usedWords);
    const overlap = first.filter((w) => second.includes(w));
    expect(overlap).toEqual([]);
  });
});

describe("describeCharacter", () => {
  it("only uses words from the pool matching the given roles' directions", () => {
    const usedWords = new Set();
    const description = describeCharacter(["Freshness", "Sweetness"], "combo-1", usedWords);
    const allWords = [...DIRECTION_VOCABULARY.light_energetic, ...DIRECTION_VOCABULARY.sweet_comforting];
    for (const word of description.split(/,?\s+with a\s+|\s+and\s+/).map((w) => w.trim()).filter(Boolean)) {
      expect(allWords).toContain(word);
    }
  });
});
