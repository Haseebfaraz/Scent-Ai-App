// Integration tests against the real imported combination database (Hybrid/Tribrid/Quadbrid).
import { describe, it, expect } from "vitest";
import prisma from "../db.server.js";
import { findExistingCombinationsForProduct, checkExactCombinationExists, findCombinationsUsingSimilarNotes } from "./combinationAnalysis.server.js";

describe("checkExactCombinationExists", () => {
  it("confirms a real existing Hybrid regardless of component order", async () => {
    const real = await prisma.existingCombination.findFirst({ where: { type: "HYBRID" } });
    const [a, b] = real.componentProductsJson;

    const forwardOrder = await checkExactCombinationExists([a, b]);
    const reverseOrder = await checkExactCombinationExists([b, a]);

    expect(forwardOrder.exists).toBe(true);
    expect(reverseOrder.exists).toBe(true);
    expect(forwardOrder.componentKey).toBe(reverseOrder.componentKey);
    expect(forwardOrder.existingCombination.title).toBe(real.title);
  });

  it("reports a genuinely new (not-yet-existing) combination as not existing", async () => {
    const [p1, p2] = await prisma.fragranceProduct.findMany({ take: 2, select: { title: true } });
    // Vanishingly unlikely two arbitrary catalog products already form a real combination —
    // if this ever legitimately exists, the ingestion data changed and the test should be revisited.
    const result = await checkExactCombinationExists([p1.title, `${p2.title} (vitest fake suffix)`]);
    expect(result.exists).toBe(false);
    expect(result.existingCombination).toBeNull();
  });
});

describe("findExistingCombinationsForProduct", () => {
  it("finds a real combination both as the finished product and via its components", async () => {
    const real = await prisma.existingCombination.findFirst({ where: { type: "HYBRID" } });
    const [componentTitle] = real.componentProductsJson;

    const asFinished = await findExistingCombinationsForProduct(real.title);
    expect(asFinished.asFinishedCombination).not.toBeNull();
    expect(asFinished.asFinishedCombination.title).toBe(real.title);

    const asComponent = await findExistingCombinationsForProduct(componentTitle);
    expect(asComponent.asComponentIn.some((c) => c.title === real.title)).toBe(true);
  });
});

describe("findCombinationsUsingSimilarNotes", () => {
  it("returns NOT_FOUND for a product that doesn't exist", async () => {
    const result = await findCombinationsUsingSimilarNotes("Totally Fake Product Name That Does Not Exist");
    expect(result).toEqual({ status: "NOT_FOUND", message: "Notes data not found" });
  });

  it("ranks real matches by real note overlap count", async () => {
    const result = await findCombinationsUsingSimilarNotes("The Opera", 5);
    expect(Array.isArray(result.matches)).toBe(true);
    for (let i = 1; i < result.matches.length; i++) {
      expect(result.matches[i - 1].overlapCount).toBeGreaterThanOrEqual(result.matches[i].overlapCount);
    }
  });
});
