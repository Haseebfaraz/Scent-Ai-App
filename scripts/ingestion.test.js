// Data-ingestion invariant checks (Phase 15) against the real, already-imported production data —
// these don't re-run the ingestion scripts (that would re-import ~936k rows on every test run);
// they verify the DATA those scripts produced still holds the invariants the spec requires.
import { describe, it, expect } from "vitest";
import prisma from "../app/db.server.js";

describe("FragranceProduct catalog", () => {
  it("has no duplicate normalizedTitle (the ingestion upsert key)", async () => {
    const rows = await prisma.fragranceProduct.findMany({ select: { normalizedTitle: true } });
    const distinct = new Set(rows.map((r) => r.normalizedTitle));
    expect(distinct.size).toBe(rows.length);
  });

  it("every row has real, non-empty notesJson", async () => {
    const rows = await prisma.fragranceProduct.findMany({ select: { notesJson: true } });
    const emptyRows = rows.filter((r) => !Array.isArray(r.notesJson) || r.notesJson.length === 0);
    expect(emptyRows.length).toBe(0);
  });
});

describe("ExistingCombination index", () => {
  it("has no duplicate componentKey (the canonical order-independent identity)", async () => {
    const rows = await prisma.existingCombination.findMany({ select: { componentKey: true } });
    const distinct = new Set(rows.map((r) => r.componentKey));
    expect(distinct.size).toBe(rows.length);
  });

  it("every Hybrid/Tribrid/Quadbrid has exactly the right component count", async () => {
    const expectedCount = { HYBRID: 2, TRIBRID: 3, QUADBRID: 4 };
    for (const type of Object.keys(expectedCount)) {
      const rows = await prisma.existingCombination.findMany({ where: { type }, select: { componentProductsJson: true, title: true } });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.componentProductsJson.length).toBe(expectedCount[type]);
      }
    }
  });

  it("correctly mapped the Quadbrid sheet's mislabeled-'Handle' header by position, not by name", async () => {
    // The Quadbrid sheet's 2nd component's "Dua Inspiration Name" header cell is literally
    // mislabeled "Handle" in the source file — this spot-checks a real imported Quadbrid row to
    // confirm its 2nd component is a real product name, not a slug/handle-shaped string.
    const quadbrids = await prisma.existingCombination.findMany({ where: { type: "QUADBRID" }, select: { componentProductsJson: true } });
    expect(quadbrids.length).toBeGreaterThan(0);
    for (const row of quadbrids) {
      for (const componentTitle of row.componentProductsJson) {
        // A real product title is never a lowercase-hyphenated slug.
        expect(componentTitle).not.toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/);
      }
    }
  });
});

describe("ProductRegionSummary precomputed table", () => {
  it("has rows for all four scopes the scoring service reads", async () => {
    const scopes = await prisma.productRegionSummary.findMany({ distinct: ["scope"], select: { scope: true } });
    const scopeNames = scopes.map((s) => s.scope).sort();
    expect(scopeNames).toEqual(["classification_global", "country", "season", "state"].sort());
  });
});
