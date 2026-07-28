import { describe, it, expect } from "vitest";
import { createCombinationKey } from "./combinationKey.js";

describe("createCombinationKey", () => {
  it("is order-independent for a Hybrid (2 products)", () => {
    const a = createCombinationKey(["The Opera", "Water of Arabia"]);
    const b = createCombinationKey(["Water of Arabia", "The Opera"]);
    expect(a).toBe(b);
  });

  it("is order-independent for a Tribrid (3 products)", () => {
    const a = createCombinationKey(["A", "B", "C"]);
    const b = createCombinationKey(["C", "A", "B"]);
    const c = createCombinationKey(["B", "C", "A"]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("is order-independent for a Quadbrid (4 products)", () => {
    const a = createCombinationKey(["A", "B", "C", "D"]);
    const b = createCombinationKey(["D", "C", "B", "A"]);
    expect(a).toBe(b);
  });

  it("normalizes case and punctuation before keying", () => {
    const a = createCombinationKey(["The Opera!", "water of arabia"]);
    const b = createCombinationKey(["  Water Of Arabia  ", "THE OPERA"]);
    expect(a).toBe(b);
  });

  it("produces different keys for genuinely different component sets", () => {
    const a = createCombinationKey(["The Opera", "Water of Arabia"]);
    const b = createCombinationKey(["The Opera", "Gone Swimming"]);
    expect(a).not.toBe(b);
  });
});
