// Phase 5 — canonical existing-combination lookups, backing find_existing_combinations_for_product,
// check_exact_combination_exists, and find_combinations_using_similar_notes. All matching goes
// through createCombinationKey/normalizeProductName so order and casing never matter, and every
// note comparison uses only FragranceProduct.notesJson — never inferred or invented notes.
import prisma from "../db.server.js";
import { normalizeProductName } from "../utils/fragranceNormalization.js";
import { createCombinationKey } from "../utils/combinationKey.js";

// ExistingCombination has ~430 rows (Hybrid+Tribrid+Quadbrid combined) — small enough to load in
// full for every call, unlike the 936k-row OrderHistory table Phase 12's performance rules target.
async function loadAllCombinations() {
  return prisma.existingCombination.findMany({
    select: { title: true, type: true, componentProductsJson: true, tagLine: true, normalizedTitle: true },
  });
}

export async function findExistingCombinationsForProduct(productTitle) {
  const normalizedTitle = normalizeProductName(productTitle);
  const combos = await loadAllCombinations();

  const asFinishedCombination = combos.find((c) => c.normalizedTitle === normalizedTitle) || null;
  const asComponentIn = combos.filter(
    (c) =>
      c.normalizedTitle !== normalizedTitle &&
      Array.isArray(c.componentProductsJson) &&
      c.componentProductsJson.some((name) => normalizeProductName(name) === normalizedTitle),
  );

  return {
    productTitle,
    asFinishedCombination: asFinishedCombination
      ? {
          title: asFinishedCombination.title,
          type: asFinishedCombination.type,
          tagLine: asFinishedCombination.tagLine,
          componentProducts: asFinishedCombination.componentProductsJson,
        }
      : null,
    asComponentIn: asComponentIn.map((c) => ({
      title: c.title,
      type: c.type,
      tagLine: c.tagLine,
      componentProducts: c.componentProductsJson,
    })),
  };
}

/**
 * @param {string[]} productTitles - candidate component product titles, any order.
 */
export async function checkExactCombinationExists(productTitles) {
  const componentKey = createCombinationKey(productTitles);
  const existing = await prisma.existingCombination.findUnique({ where: { componentKey } });
  return {
    componentKey,
    exists: Boolean(existing),
    existingCombination: existing
      ? { title: existing.title, type: existing.type, tagLine: existing.tagLine, componentProducts: existing.componentProductsJson }
      : null,
  };
}

/**
 * Existing combinations whose component products share real notes with `productTitle`, ranked by
 * overlap count — used to surface "combinations built from similar materials" evidence.
 */
export async function findCombinationsUsingSimilarNotes(productTitle, limit = 5) {
  const normalizedTitle = normalizeProductName(productTitle);
  const referenceProduct = await prisma.fragranceProduct.findUnique({ where: { normalizedTitle } });
  if (!referenceProduct) return { status: "NOT_FOUND", message: "Notes data not found" };

  const referenceNotes = new Set(
    (Array.isArray(referenceProduct.notesJson) ? referenceProduct.notesJson : []).map((n) => String(n).toLowerCase()),
  );
  if (!referenceNotes.size) return { productTitle, matches: [] };

  const [combos, allProducts] = await Promise.all([
    loadAllCombinations(),
    prisma.fragranceProduct.findMany({ select: { normalizedTitle: true, notesJson: true } }),
  ]);
  const notesByNormalizedTitle = new Map(
    allProducts.map((p) => [p.normalizedTitle, Array.isArray(p.notesJson) ? p.notesJson : []]),
  );

  const scored = combos
    .filter((c) => c.normalizedTitle !== normalizedTitle)
    .map((c) => {
      const componentNotes = new Set();
      for (const name of Array.isArray(c.componentProductsJson) ? c.componentProductsJson : []) {
        const notes = notesByNormalizedTitle.get(normalizeProductName(name)) || [];
        notes.forEach((n) => componentNotes.add(String(n).toLowerCase()));
      }
      const overlappingNotes = [...componentNotes].filter((n) => referenceNotes.has(n));
      return { combo: c, overlappingNotes };
    })
    .filter((r) => r.overlappingNotes.length > 0)
    .sort((a, b) => b.overlappingNotes.length - a.overlappingNotes.length)
    .slice(0, limit);

  return {
    productTitle,
    matches: scored.map((r) => ({
      title: r.combo.title,
      type: r.combo.type,
      tagLine: r.combo.tagLine,
      overlappingNotes: r.overlappingNotes,
      overlapCount: r.overlappingNotes.length,
    })),
  };
}
