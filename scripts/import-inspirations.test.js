// Unit-level tests for importInspirations against the real dev database — uses a handful of
// throwaway FragranceProduct rows (created/cleaned up per test) plus a synthetic in-memory
// "workbook" built with XLSX.utils.aoa_to_sheet, matching the real sheet's merged-title-row-then-
// header-then-data layout, so these never depend on (or mutate) the real 3,450-row catalog.
import { describe, it, expect, afterEach } from "vitest";
import XLSX from "xlsx";
import prisma from "../app/db.server.js";
import { normalizeProductName } from "../app/utils/fragranceNormalization.js";
import { importInspirations } from "./import-hybrid-catalog.cjs";

const createdProductIds = [];
afterEach(async () => {
  if (createdProductIds.length) {
    await prisma.fragranceProduct.deleteMany({ where: { id: { in: createdProductIds } } });
    createdProductIds.length = 0;
  }
});

async function makeTestProduct({ title, handle }) {
  const suffix = `-vitest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const uniqueTitle = `${title}${suffix}`;
  const product = await prisma.fragranceProduct.create({
    data: {
      title: uniqueTitle,
      normalizedTitle: normalizeProductName(uniqueTitle),
      handle: handle ? `${handle}${suffix}` : null,
      notesJson: ["Bergamot", "Musk"],
    },
  });
  createdProductIds.push(product.id);
  return product;
}

// Builds a workbook with an "Inspirations" sheet matching the real layout: a merged category-
// title row, a real header row, then data rows — exactly what readSheetRows/slice(2) expects.
function buildWorkbook(dataRows) {
  const aoa = [
    ["INSPIRED EXPRESSION", null, null, null, null],
    ["Handle", "Title", "Tag Line", "Inspiration", "Brand"],
    ...dataRows,
  ];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  return { Sheets: { Inspirations: sheet } };
}

describe("importInspirations", () => {
  it("matches a row by normalized title and enriches the existing product (no new row created)", async () => {
    const product = await makeTestProduct({ title: "Test Opera Blend", handle: "test-opera-blend" });

    const workbook = buildWorkbook([
      [product.handle, product.title, "Inspiration: Opera by Sospiro", "Opera", "Sospiro"],
    ]);
    const result = await importInspirations(workbook, normalizeProductName);

    expect(result.imported).toBe(1);
    expect(result.matchedByTitle).toBe(1);
    expect(result.matchedByHandle).toBe(0);
    expect(result.alreadyIdentical).toBe(0);
    expect(result.totalRows).toBe(1);
    expect(result.skipped).toEqual([]);

    // Duplicate prevention — exactly one row for THIS product's normalizedTitle, never two.
    // (A global fragranceProduct.count() comparison isn't safe here: Vitest runs test files
    // concurrently by default, and other files create/delete their own rows in this same window.)
    const rowsForThisTitle = await prisma.fragranceProduct.count({ where: { normalizedTitle: product.normalizedTitle } });
    expect(rowsForThisTitle).toBe(1);

    const updated = await prisma.fragranceProduct.findUnique({ where: { id: product.id } });
    expect(updated.isSingleInspiration).toBe(true);
    expect(updated.tagLine).toBe("Inspiration: Opera by Sospiro");
    expect(updated.inspirationName).toBe("Opera");
    expect(updated.inspirationBrand).toBe("Sospiro");
  });

  it("is idempotent: re-running against unchanged data updates nothing and creates no duplicates", async () => {
    const product = await makeTestProduct({ title: "Test Idempotent Blend", handle: "test-idempotent-blend" });

    const workbook = buildWorkbook([
      [product.handle, product.title, "Inspiration: Idempotent by Nobody", "Idempotent", "Nobody"],
    ]);

    const first = await importInspirations(workbook, normalizeProductName);
    expect(first.imported).toBe(1);
    expect(first.alreadyIdentical).toBe(0);

    const second = await importInspirations(workbook, normalizeProductName);
    expect(second.imported).toBe(0);
    expect(second.alreadyIdentical).toBe(1);
    expect(second.matchedByTitle).toBe(1);

    const rowsForThisTitle = await prisma.fragranceProduct.count({ where: { normalizedTitle: product.normalizedTitle } });
    expect(rowsForThisTitle).toBe(1);
  });

  it("falls back to matching by handle when the title text differs between sheets", async () => {
    const product = await makeTestProduct({ title: "Test Water Blend", handle: "test-water-blend" });

    const workbook = buildWorkbook([
      // Deliberately different title text, but the same real handle.
      [product.handle, "A Completely Different Title Text", "Inspiration: Silver Mountain Water by Creed", "Silver Mountain Water", "Creed"],
    ]);
    const result = await importInspirations(workbook, normalizeProductName);

    expect(result.imported).toBe(1);
    expect(result.matchedByTitle).toBe(0);
    expect(result.matchedByHandle).toBe(1);
    const updated = await prisma.fragranceProduct.findUnique({ where: { id: product.id } });
    expect(updated.inspirationName).toBe("Silver Mountain Water");
    expect(updated.inspirationBrand).toBe("Creed");
  });

  it("logs and skips a row that matches neither an existing title nor handle — never creates one", async () => {
    const fakeTitle = "A Product That Does Not Exist Anywhere";
    const workbook = buildWorkbook([
      ["totally-unknown-handle", fakeTitle, "Inspiration: Nothing by Nobody", "Nothing", "Nobody"],
    ]);
    const result = await importInspirations(workbook, normalizeProductName);

    expect(result.imported).toBe(0);
    expect(result.matchedByTitle).toBe(0);
    expect(result.matchedByHandle).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/No matching FragranceProduct found/);

    const createdForFakeTitle = await prisma.fragranceProduct.count({ where: { normalizedTitle: normalizeProductName(fakeTitle) } });
    expect(createdForFakeTitle).toBe(0);
  });

  it("skips a row with a missing title without throwing", async () => {
    const workbook = buildWorkbook([[null, null, "some tag line", "X", "Y"]]);
    const result = await importInspirations(workbook, normalizeProductName);
    expect(result.imported).toBe(0);
    expect(result.skipped[0].reason).toMatch(/Title.*missing/);
  });

  it("returns a clear result when the Inspirations sheet itself is missing", async () => {
    const result = await importInspirations({ Sheets: {} }, normalizeProductName);
    expect(result.imported).toBe(0);
    expect(result.skipped[0].reason).toMatch(/Sheet "Inspirations" not found/);
  });
});
