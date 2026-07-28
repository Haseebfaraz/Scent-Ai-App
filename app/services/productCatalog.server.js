// Phase 4 — backs the get_product_notes_and_combination_status tool. Only ever returns notes
// already stored on FragranceProduct (imported by scripts/import-hybrid-catalog.cjs) — never
// infers notes from a product's title or name.
import prisma from "../db.server.js";
import { normalizeProductName } from "../utils/fragranceNormalization.js";

// notesJson preserves the source spreadsheet's note order — the first few entries are treated as
// "main" notes and the rest as "supporting," matching the same prominence convention
// app/utils/fragranceScoring.js already uses for dislike-conflict severity (PROMINENT_NOTE_WINDOW).
// This is a positional heuristic on real stored data, not an inferred/invented split.
const MAIN_NOTE_COUNT = 3;

async function combinationsInvolving(normalizedTitle) {
  const combos = await prisma.existingCombination.findMany({
    select: { title: true, type: true, componentProductsJson: true, tagLine: true, normalizedTitle: true },
  });
  const asFinishedCombination = combos.find((c) => c.normalizedTitle === normalizedTitle) || null;
  const asComponentIn = combos.filter(
    (c) =>
      c.normalizedTitle !== normalizedTitle &&
      Array.isArray(c.componentProductsJson) &&
      c.componentProductsJson.some((name) => normalizeProductName(name) === normalizedTitle),
  );
  return { asFinishedCombination, asComponentIn };
}

/**
 * @param {string} productTitle - exact or approximate product title (matched via normalization).
 * @returns {Promise<object>} FOUND result per Phase 4, or { status: "NOT_FOUND", message } — the
 *   exact shape/message Phase 4 requires when nothing matches.
 */
export async function getProductNotesAndCombinationStatus(productTitle) {
  const normalizedTitle = normalizeProductName(productTitle);
  const product = await prisma.fragranceProduct.findUnique({ where: { normalizedTitle } });
  if (!product) {
    return { status: "NOT_FOUND", message: "Notes data not found" };
  }

  const notes = Array.isArray(product.notesJson) ? product.notesJson : [];
  const { asFinishedCombination, asComponentIn } = await combinationsInvolving(normalizedTitle);

  return {
    status: "FOUND",
    title: product.title,
    handle: product.handle,
    mainNotes: notes.slice(0, MAIN_NOTE_COUNT),
    supportingNotes: notes.slice(MAIN_NOTE_COUNT),
    fragranceFamily: product.fragranceFamily,
    collection: product.collection,
    // Real, stored flag set only by the "Inspirations" sheet import (scripts/import-hybrid-
    // catalog.cjs) — replaces the earlier collection-based guess, since a product's Collection
    // value alone doesn't confirm the Inspirations sheet actually covers it.
    isSingleInspiration: product.isSingleInspiration,
    tagLine: product.tagLine,
    inspirationName: product.inspirationName,
    inspirationBrand: product.inspirationBrand,
    isHybrid: asFinishedCombination?.type === "HYBRID",
    isTribrid: asFinishedCombination?.type === "TRIBRID",
    isQuadbrid: asFinishedCombination?.type === "QUADBRID",
    appearsAsComponentIn: asComponentIn.map((c) => ({ title: c.title, type: c.type, tagLine: c.tagLine })),
    matchingExistingCombinations: [
      ...(asFinishedCombination
        ? [{ title: asFinishedCombination.title, type: asFinishedCombination.type, tagLine: asFinishedCombination.tagLine, role: "isThisProduct" }]
        : []),
      ...asComponentIn.map((c) => ({ title: c.title, type: c.type, tagLine: c.tagLine, role: "component" })),
    ],
    missingDataFlags: {
      notes: notes.length === 0,
      fragranceFamily: !product.fragranceFamily,
      pricePer5ml: product.pricePer5ml == null,
    },
  };
}
