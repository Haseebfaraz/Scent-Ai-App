// Regression tests for the deterministic early-phase fragrance-bridge gate — real bug: a bare
// "great, yours?" or "testing" reply still got answered with a stacked "how's your day / anything
// special you're looking for in a fragrance today?" even after prompt-only instructions explicitly
// forbade it, twice in a row. hasConcreteContext is the deterministic check that decides whether
// buildSystemPrompt hands the model the short, fragrance-free prompt or the full one.
import { describe, it, expect } from "vitest";
import { hasConcreteContext } from "../routes/chat.jsx";

describe("hasConcreteContext", () => {
  it("returns false for bare mood/filler replies with no real signal", () => {
    expect(hasConcreteContext("great yours?")).toBe(false);
    expect(hasConcreteContext("testing")).toBe(false);
    expect(hasConcreteContext("good")).toBe(false);
    expect(hasConcreteContext("not well")).toBe(false);
    expect(hasConcreteContext("")).toBe(false);
    expect(hasConcreteContext(undefined)).toBe(false);
  });

  it("returns true the moment a real activity/occasion/gift/fragrance word appears", () => {
    expect(hasConcreteContext("going to the gym later")).toBe(true);
    expect(hasConcreteContext("it's my wife's birthday")).toBe(true);
    expect(hasConcreteContext("need a gift for my husband")).toBe(true);
    expect(hasConcreteContext("I want to buy a perfume")).toBe(true);
    expect(hasConcreteContext("big meeting today")).toBe(true);
  });
});
