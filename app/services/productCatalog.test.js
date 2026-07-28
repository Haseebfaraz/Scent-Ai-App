import { describe, it, expect, afterEach } from "vitest";
import prisma from "../db.server.js";
import { normalizeProductName } from "../utils/fragranceNormalization.js";
import { getProductNotesAndCombinationStatus } from "./productCatalog.server.js";

const createdProductIds = [];
afterEach(async () => {
  if (createdProductIds.length) {
    await prisma.fragranceProduct.deleteMany({ where: { id: { in: createdProductIds } } });
    createdProductIds.length = 0;
  }
});

describe("getProductNotesAndCombinationStatus", () => {
  it("returns NOT_FOUND with the exact spec-required shape for an unknown product", async () => {
    const result = await getProductNotesAndCombinationStatus("Totally Fake Product Name That Does Not Exist");
    expect(result).toEqual({ status: "NOT_FOUND", message: "Notes data not found" });
  });

  it("returns real, stored notes for a real product — never inferred from its title", async () => {
    // Excludes "vitest"-titled rows — other test files create/delete their own throwaway
    // FragranceProduct rows under that marker, and Vitest runs test files concurrently by default.
    const real = await prisma.fragranceProduct.findFirst({ where: { notesJson: { not: null }, NOT: { title: { contains: "vitest" } } } });
    const result = await getProductNotesAndCombinationStatus(real.title);

    expect(result.status).toBe("FOUND");
    expect(result.title).toBe(real.title);
    const allNotes = [...result.mainNotes, ...result.supportingNotes];
    expect(allNotes).toEqual(real.notesJson);
  });

  it("correctly identifies a real Hybrid as isHybrid, and its component as appearing in it", async () => {
    const hybrid = await prisma.existingCombination.findFirst({ where: { type: "HYBRID" } });
    const hybridResult = await getProductNotesAndCombinationStatus(hybrid.title);
    expect(hybridResult.isHybrid).toBe(true);
    expect(hybridResult.isTribrid).toBe(false);
    expect(hybridResult.isQuadbrid).toBe(false);

    const [componentTitle] = hybrid.componentProductsJson;
    const componentResult = await getProductNotesAndCombinationStatus(componentTitle);
    expect(componentResult.appearsAsComponentIn.some((c) => c.title === hybrid.title)).toBe(true);
  });

  it("returns real Inspirations metadata (tagLine/inspirationName/inspirationBrand) when present", async () => {
    const title = `Test Inspiration Product ${Date.now()}`;
    const product = await prisma.fragranceProduct.create({
      data: {
        title,
        normalizedTitle: normalizeProductName(title),
        notesJson: ["Rose", "Musk"],
        isSingleInspiration: true,
        tagLine: "Inspiration: Opera by Sospiro",
        inspirationName: "Opera",
        inspirationBrand: "Sospiro",
      },
    });
    createdProductIds.push(product.id);

    const result = await getProductNotesAndCombinationStatus(title);
    expect(result.isSingleInspiration).toBe(true);
    expect(result.tagLine).toBe("Inspiration: Opera by Sospiro");
    expect(result.inspirationName).toBe("Opera");
    expect(result.inspirationBrand).toBe("Sospiro");
  });

  it("returns false/null Inspirations metadata for a product the Inspirations sheet never covers", async () => {
    const title = `Test Non-Inspiration Product ${Date.now()}`;
    const product = await prisma.fragranceProduct.create({
      data: { title, normalizedTitle: normalizeProductName(title), notesJson: ["Oud"] },
    });
    createdProductIds.push(product.id);

    const result = await getProductNotesAndCombinationStatus(title);
    expect(result.isSingleInspiration).toBe(false);
    expect(result.tagLine).toBeNull();
    expect(result.inspirationName).toBeNull();
    expect(result.inspirationBrand).toBeNull();
  });
});
