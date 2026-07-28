import { describe, it, expect } from "vitest";
import prisma from "../db.server.js";
import { getProductNotesAndCombinationStatus } from "./productCatalog.server.js";

describe("getProductNotesAndCombinationStatus", () => {
  it("returns NOT_FOUND with the exact spec-required shape for an unknown product", async () => {
    const result = await getProductNotesAndCombinationStatus("Totally Fake Product Name That Does Not Exist");
    expect(result).toEqual({ status: "NOT_FOUND", message: "Notes data not found" });
  });

  it("returns real, stored notes for a real product — never inferred from its title", async () => {
    const real = await prisma.fragranceProduct.findFirst({ where: { notesJson: { not: null } } });
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
});
