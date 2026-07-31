// Regression tests for the "price doesn't change with ratio" bug — confirmed live, three very
// different Top/Heart/Base ratios (34/33/33, 10/80/10, 5/90/5) on the same saved product all priced
// at the identical $158.23. Root cause: every position was assigned the exact same blended $/5ml
// rate, so `rate * (top_ml + middle_ml + base_ml)` collapsed to a constant regardless of split.
import { describe, it, expect } from "vitest";
import { computePricePer5mlByPosition } from "./fragranceBuild.server.js";
import { estimateTotalPrice } from "../utils/fragrancePricing.js";

describe("estimateTotalPrice — price must actually change when the ratio changes", () => {
  it("returns different totals for different ratio splits when positions have different rates", () => {
    const rates = { top: 10, middle: 50, base: 10 }; // $/5ml, deliberately not all equal
    const evenSplit = estimateTotalPrice(rates, { top: 34, middle: 33, base: 33 });
    const heartHeavy = estimateTotalPrice(rates, { top: 10, middle: 80, base: 10 });

    // This is exactly the bug: with a single blended rate these would have been identical.
    expect(heartHeavy).not.toBeCloseTo(evenSplit, 5);
    // More Heart (the expensive position) should cost more, not the same or less.
    expect(heartHeavy).toBeGreaterThan(evenSplit);
  });

  it("returns the same total when all positions share one rate (the old, now-incorrect behavior)", () => {
    const rates = { top: 20, middle: 20, base: 20 };
    const a = estimateTotalPrice(rates, { top: 34, middle: 33, base: 33 });
    const b = estimateTotalPrice(rates, { top: 10, middle: 80, base: 10 });
    expect(a).toBeCloseTo(b, 5);
  });
});

describe("computePricePer5mlByPosition — real per-product/per-note attribution (integration)", () => {
  it("returns a positive $/5ml rate for every position for a real two-product combination", async () => {
    const internalProducts = [
      { title: "The Opera", notes: ["Rose", "Fruity Notes", "Ambergris", "Leather", "Nutmeg", "Cedar", "Vanilla", "Musk"] },
      { title: "Water of Arabia", notes: ["Mandarin", "Bergamot", "Blackcurrant", "Green Tea", "Sandalwood"] },
    ];
    const ratiosByProduct = [
      { productTitle: "The Opera", ratioPercent: 50 },
      { productTitle: "Water of Arabia", ratioPercent: 50 },
    ];

    const rates = await computePricePer5mlByPosition(internalProducts, ratiosByProduct);

    expect(rates.top).toBeGreaterThan(0);
    expect(rates.middle).toBeGreaterThan(0);
    expect(rates.base).toBeGreaterThan(0);
  });
});
