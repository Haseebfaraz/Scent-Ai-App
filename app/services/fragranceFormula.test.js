import { describe, it, expect } from "vitest";
import {
  FINISHED_BOTTLE_ML, DEFAULT_OIL_ML, MIN_OIL_ML, MAX_OIL_ML,
  computeAlcoholMl, computeRequiredOilMl, buildProductionFormula,
  computeComponentCapacity, computeFeasibility,
} from "./fragranceFormula.server.js";

describe("computeAlcoholMl (Required Tests: bottle/oil/alcohol split)", () => {
  it("34 ml bottle + 13 ml oil -> 21 ml alcohol", () => {
    expect(computeAlcoholMl(13)).toBe(21);
  });
  it("12 ml oil -> 22 ml alcohol", () => {
    expect(computeAlcoholMl(MIN_OIL_ML)).toBe(22);
  });
  it("14 ml oil -> 20 ml alcohol", () => {
    expect(computeAlcoholMl(MAX_OIL_ML)).toBe(20);
  });
  it("defaults to the 13 ml default oil amount", () => {
    expect(computeAlcoholMl()).toBe(FINISHED_BOTTLE_ML - DEFAULT_OIL_ML);
  });
});

describe("buildProductionFormula (Required Tests: ratio -> oil ml, using the 13 ml default)", () => {
  it("Hybrid 65/35 -> 8.45 ml + 4.55 ml", () => {
    const formula = buildProductionFormula([
      { productTitle: "Herbs & Sea Salt", ratioPercent: 65 },
      { productTitle: "Cali Life", ratioPercent: 35 },
    ]);
    expect(formula.oilTotalMl).toBe(13);
    expect(formula.alcoholMl).toBe(21);
    expect(formula.components.map((c) => c.requiredOilMl)).toEqual([8.45, 4.55]);
  });

  it("Hybrid 60/40 -> 7.80 ml + 5.20 ml", () => {
    const formula = buildProductionFormula([
      { productTitle: "A", ratioPercent: 60 },
      { productTitle: "B", ratioPercent: 40 },
    ]);
    expect(formula.components.map((c) => c.requiredOilMl)).toEqual([7.8, 5.2]);
  });

  it("Tribrid 50/30/20 -> 6.50 / 3.90 / 2.60 ml", () => {
    const formula = buildProductionFormula([
      { productTitle: "A", ratioPercent: 50 },
      { productTitle: "B", ratioPercent: 30 },
      { productTitle: "C", ratioPercent: 20 },
    ]);
    expect(formula.components.map((c) => c.requiredOilMl)).toEqual([6.5, 3.9, 2.6]);
  });

  it("Quadbrid 40/30/20/10 -> 5.20 / 3.90 / 2.60 / 1.30 ml", () => {
    const formula = buildProductionFormula([
      { productTitle: "A", ratioPercent: 40 },
      { productTitle: "B", ratioPercent: 30 },
      { productTitle: "C", ratioPercent: 20 },
      { productTitle: "D", ratioPercent: 10 },
    ]);
    expect(formula.components.map((c) => c.requiredOilMl)).toEqual([5.2, 3.9, 2.6, 1.3]);
  });

  it("rejects ratios that don't total 100% within tolerance", () => {
    expect(() => buildProductionFormula([{ productTitle: "A", ratioPercent: 60 }, { productTitle: "B", ratioPercent: 30 }])).toThrow(/total 100/);
  });

  it("rejects a negative ratio", () => {
    expect(() => buildProductionFormula([{ productTitle: "A", ratioPercent: -10 }, { productTitle: "B", ratioPercent: 110 }])).toThrow(/non-negative/);
  });

  it("rejects a NaN ratio", () => {
    expect(() => buildProductionFormula([{ productTitle: "A", ratioPercent: NaN }, { productTitle: "B", ratioPercent: 100 }])).toThrow(/non-negative/);
  });

  it("rejects an empty formula", () => {
    expect(() => buildProductionFormula([])).toThrow(/at least one/);
  });

  it("rejects an oilTotalMl outside the 12-14ml range", () => {
    expect(() => buildProductionFormula([{ productTitle: "A", ratioPercent: 100 }], 16)).toThrow(/between 12 and 14/);
  });
});

describe("computeComponentCapacity / computeFeasibility (Required Tests: buildable/max-bottles/limiting oil)", () => {
  it("all oils available -> BUILDABLE, with the mandatory acceptance scenario's exact numbers", () => {
    // Section 24 of the oil-inventory spec: Herbs & Sea Salt 65% / Cali Life 35%, 13ml oil default.
    const result = computeFeasibility([
      { productTitle: "Herbs & Sea Salt", requiredOilMl: 8.45, availableOilMl: 500 },
      { productTitle: "Cali Life", requiredOilMl: 4.55, availableOilMl: 100 },
    ]);
    expect(result.buildable).toBe(true);
    expect(result.maximumBuildableBottles).toBe(21);
    expect(result.limitingProductTitle).toBe("Cali Life");
  });

  it("any required oil insufficient -> NOT_BUILDABLE (failure case from the spec: 3ml available, 4.55ml required)", () => {
    const result = computeFeasibility([
      { productTitle: "Herbs & Sea Salt", requiredOilMl: 8.45, availableOilMl: 500 },
      { productTitle: "Cali Life", requiredOilMl: 4.55, availableOilMl: 3 },
    ]);
    expect(result.buildable).toBe(false);
    expect(result.maximumBuildableBottles).toBe(0);
  });

  it("treats a null/unknown availableOilMl as zero capacity, not a crash", () => {
    const result = computeFeasibility([{ productTitle: "A", requiredOilMl: 5, availableOilMl: null }]);
    expect(result.buildable).toBe(false);
    expect(result.components[0].capacity).toBe(0);
  });

  it("computeComponentCapacity floors to whole bottles", () => {
    expect(computeComponentCapacity(100, 4.55)).toBe(21);
    expect(computeComponentCapacity(0, 4.55)).toBe(0);
    expect(computeComponentCapacity(100, 0)).toBe(0);
  });
});
