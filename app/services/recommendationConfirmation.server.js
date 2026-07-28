// Phase 10 — save_recommendation / confirm_product_combination. A FragranceRecommendation row is
// the immutable record the confirmation tool re-verifies against; the model only ever passes a
// recommendationId, never a free-form reconstructed product array (per Phase 13 point 7's
// explicit fix for the old confirmation flow).
import prisma from "../db.server.js";
import { normalizeProductName } from "../utils/fragranceNormalization.js";
import { classifyDislikeConflict } from "../utils/fragranceScoring.js";
import { textToPreferenceFamilies } from "../utils/fragranceCompatibility.js";
import { validateCombinationShape } from "./recommendationEngine.server.js";

const COMPONENT_COUNT_BY_TYPE = { HYBRID: 2, TRIBRID: 3, QUADBRID: 4 };
// No exact expiry window is specified in the spec beyond "has not expired" — 24h is a deliberate,
// documented choice: long enough to survive a customer stepping away mid-conversation, short
// enough that a confirmation can't fire against a catalog that's since changed underneath it.
const RECOMMENDATION_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Persists one generated ProposedCombination (from recommendationEngine.server.js) as an
 * immutable, confirmable record.
 */
export async function saveRecommendation({ conversationId, profile, combination }) {
  // Fix 4 — the same hard shape gate the engine already applies at generation time, re-run here as
  // defense in depth: a recommendation can never be PERSISTED with the wrong product count, a
  // duplicate product, or a 100%-one-product ratio, regardless of what produced the object.
  validateCombinationShape({
    type: combination.type,
    products: combination.internalProducts,
    recommendedRatio: combination.recommendedRatio,
  });

  const record = await prisma.fragranceRecommendation.create({
    data: {
      conversationId,
      customerProfileJson: profile,
      productsJson: combination.internalProducts,
      combinationType: combination.type,
      scoreJson: {
        preferenceScore: combination.preferenceScore,
        seasonalScore: combination.seasonalScore,
        historyScore: combination.historyScore,
        compatibilityScore: combination.compatibilityScore,
        balanceScore: combination.balanceScore,
        conflictPenalty: combination.conflictPenalty,
        finalScore: combination.finalScore,
        confidence: combination.confidence,
      },
      evidenceJson: {
        historicalEvidence: combination.historicalEvidence,
        analogousExistingCombinations: combination.analogousExistingCombinations,
        compatibilityReasons: combination.compatibilityReasons,
        risks: combination.risks,
        canonicalKey: combination.canonicalKey,
      },
      ratiosJson: combination.recommendedRatio,
      evidenceScope: combination.evidenceScope,
      customerFacingJson: {
        customerFacingName: combination.customerFacingName,
        customerFacingDescription: combination.customerFacingDescription,
        customerFacingWhySuits: combination.customerFacingWhySuits,
        customerFacingBestUse: combination.customerFacingBestUse,
        customerFacingWeatherSuitability: combination.customerFacingWeatherSuitability,
        customerFacingStrength: combination.customerFacingStrength,
        customerFacingRisk: combination.customerFacingRisk,
      },
      status: "pending",
    },
  });
  return record.id;
}

// Fix 3 — the only shape any customer-facing surface (SSE payload, recommendation card, the
// model's own narration) may ever read. Never includes productsJson/evidenceJson (real source
// titles/notes) or scoreJson's raw numbers.
export function toCustomerSafeRecommendation(record) {
  return {
    recommendationId: record.id,
    type: record.combinationType,
    existsAlready: false,
    evidenceScope: record.evidenceScope,
    confidence: record.scoreJson?.confidence,
    ...record.customerFacingJson,
  };
}

export async function getRecommendation(recommendationId) {
  return prisma.fragranceRecommendation.findUnique({ where: { id: recommendationId } });
}

/**
 * Re-verifies everything deterministically before Shopify product creation is allowed to proceed —
 * per Phase 10, never trusts the generation-time snapshot for any of these checks.
 * @returns {Promise<{ok: true, recommendation: object} | {ok: false, reason: string}>}
 */
export async function confirmRecommendation({ recommendationId, customerName, customerEmail }) {
  const record = await prisma.fragranceRecommendation.findUnique({ where: { id: recommendationId } });
  if (!record) return { ok: false, reason: "Recommendation not found." };
  if (record.status === "confirmed") return { ok: false, reason: "This recommendation has already been confirmed." };
  if (record.status === "expired") return { ok: false, reason: "This recommendation has expired — please generate a new one." };

  const ageMs = Date.now() - new Date(record.createdAt).getTime();
  if (ageMs > RECOMMENDATION_EXPIRY_MS) {
    await prisma.fragranceRecommendation.update({ where: { id: recommendationId }, data: { status: "expired" } });
    return { ok: false, reason: "This recommendation has expired — please generate a new one." };
  }

  if (!customerName || !customerEmail) {
    return { ok: false, reason: "Customer name and email must be available from the Shopify account before creating a product." };
  }

  const products = Array.isArray(record.productsJson) ? record.productsJson : [];
  const expectedCount = COMPONENT_COUNT_BY_TYPE[record.combinationType];
  if (!expectedCount || products.length !== expectedCount) {
    return { ok: false, reason: `Product count (${products.length}) doesn't match ${record.combinationType} (expects ${expectedCount}).` };
  }

  for (const p of products) {
    const catalogProduct = await prisma.fragranceProduct.findUnique({
      where: { normalizedTitle: normalizeProductName(p.title) },
    });
    if (!catalogProduct) return { ok: false, reason: `Product "${p.title}" no longer exists in the catalog.` };
    if (!Array.isArray(catalogProduct.notesJson) || catalogProduct.notesJson.length === 0) {
      return { ok: false, reason: `Product "${p.title}" has no notes data.` };
    }
  }

  // Must not already exist as a real combination now — this engine only ever proposes genuinely
  // new combinations, so re-confirm it's still new (the catalog could have changed since).
  const componentKey = record.evidenceJson?.canonicalKey;
  if (componentKey) {
    const existing = await prisma.existingCombination.findUnique({ where: { componentKey } });
    if (existing) {
      return { ok: false, reason: `"${existing.title}" already exists as a real combination now — cannot create a duplicate.` };
    }
  }

  const ratios = Array.isArray(record.ratiosJson) ? record.ratiosJson : [];
  const pctSum = ratios.reduce((sum, r) => sum + (r.ratioPercent || 0), 0);
  if (pctSum !== 100) {
    return { ok: false, reason: `Ratios sum to ${pctSum}%, not 100%.` };
  }

  // Recompute dislike-conflict severity against the CURRENT profile's dislikes — never trusts the
  // generation-time snapshot for this safety check.
  const dislikeFamilies = textToPreferenceFamilies(record.customerProfileJson?.dislikes || []);
  for (const p of products) {
    const conflict = classifyDislikeConflict(p.notes, dislikeFamilies);
    if (conflict.severity === "high") {
      return { ok: false, reason: `"${p.title}" has a high-severity conflict with a disliked note/family — cannot confirm.` };
    }
  }

  const confirmed = await prisma.fragranceRecommendation.update({
    where: { id: recommendationId },
    data: { status: "confirmed", confirmedAt: new Date() },
  });

  return { ok: true, recommendation: confirmed };
}

export async function markRecommendationShopifyProduct(recommendationId, shopifyProductId) {
  await prisma.fragranceRecommendation.update({
    where: { id: recommendationId },
    data: { shopifyProductId },
  });
}
