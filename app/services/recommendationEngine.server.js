// Phase 6/7 — generate_new_product_combinations. Builds NEW Hybrid/Tribrid/Quadbrid proposals from
// real catalog products, scores them on the spec's compatibility dimensions, and computes
// deterministic mixing ratios. Never proposes a combination already present in ExistingCombination
// (checked via the same canonical componentKey used everywhere else), and never invents a product,
// note, or ratio — every number here is either a real per-product order-history count (passed in
// via candidateProducts, from analyzeCustomerProductCandidates) or derived from real
// FragranceProduct.notesJson.
import prisma from "../db.server.js";
import { createCombinationKey } from "../utils/combinationKey.js";
import { normalizeProductName } from "../utils/fragranceNormalization.js";
import {
  PREFERENCE_FAMILIES,
  COMPATIBILITY_TAGS,
  detectFamilies,
  pairIsCompatible,
  assessCombinationRisks,
  textToPreferenceFamilies,
} from "../utils/fragranceCompatibility.js";
import { SCORE_WEIGHTS, classifyDislikeConflict, matchedLikes } from "../utils/fragranceScoring.js";

const DEFAULT_MAX_RESULTS = 8;
const BOTTLE_ML = 34;
const COMPONENT_COUNT_BY_TYPE = { HYBRID: 2, TRIBRID: 3, QUADBRID: 4 };
const ALL_TYPES = ["HYBRID", "TRIBRID", "QUADBRID"];
// Bounds on the combinatorial search — top N order-history candidates act as "anchors" (the real
// product the combination is built around), each paired with its own shortlist of the most
// compatible supporting products, so the search never explodes across the full ~3450-product
// catalog.
const MAX_ANCHORS = 5;
const MAX_SUPPORT_SHORTLIST = 8;

const ALL_FAMILIES = { ...PREFERENCE_FAMILIES, ...COMPATIBILITY_TAGS };

function familiesOf(notes) {
  return detectFamilies(notes, ALL_FAMILIES);
}

// Fraction of the SMALLER note list shared between two products. Two genuinely different products
// that happen to both be, say, fruity+vanilla typically share a handful of notes; two entries from
// the same product line ("Poseidon's Elixir 2.0"/"16A"/"13N", "Princeless Princess"/"Hey Princeless
// Sweetie") share most or all of theirs. PREFERENCE_FAMILIES/COMPATIBILITY_TAGS deliberately share
// keywords (e.g. "vanilla" triggers both `sweet` and the `vanilla` tag), so a same-line sibling can
// still register a "compatible family pair" — this ratio catches what family-matching alone can't.
function noteOverlapRatio(notesA, notesB) {
  const setA = new Set((notesA || []).map((n) => String(n).toLowerCase()));
  const setB = new Set((notesB || []).map((n) => String(n).toLowerCase()));
  if (!setA.size || !setB.size) return 0;
  const overlap = [...setA].filter((n) => setB.has(n)).length;
  return overlap / Math.min(setA.size, setB.size);
}
const NEAR_DUPLICATE_OVERLAP_RATIO = 0.5;

function* combinationsOf(items, k) {
  if (k === 0) {
    yield [];
    return;
  }
  for (let i = 0; i <= items.length - k; i++) {
    for (const rest of combinationsOf(items.slice(i + 1), k - 1)) {
      yield [items[i], ...rest];
    }
  }
}

// Each product in a combination must have "a defined role... Freshness / Main fruit body /
// Sweetness / Floral bridge / Musk-wood base / Contrast / Longevity support" (Phase 6, spec's own
// examples). Priority order picks the single most salient detected family per product.
const FAMILY_ROLE_PRIORITY = [
  ["fresh", "Freshness"],
  ["fruity", "Main fruit body"],
  ["sweet", "Sweetness"],
  ["floral", "Floral bridge"],
  ["musk", "Musk/wood base"],
  ["woody", "Musk/wood base"],
  ["amber", "Musk/wood base"],
  ["strongHeavy", "Longevity support"],
];

export function assignRoles(comboProducts) {
  return comboProducts.map((p) => {
    const families = familiesOf(p.notes);
    const match = FAMILY_ROLE_PRIORITY.find(([family]) => families.includes(family));
    return { ...p, role: match ? match[1] : "Contrast", hasDetectedFamily: families.length > 0 };
  });
}

// Phase 7 ratio guidance, as fixed parts-per-role rather than a single number the model could
// invent. "Two similarly balanced fruity products: 1:1" is handled as a special case below.
const ROLE_PARTS = {
  Freshness: 2,
  "Main fruit body": 2,
  "Floral bridge": 2,
  Sweetness: 1,
  "Musk/wood base": 1,
  "Longevity support": 1,
  Contrast: 1,
};
// "Very sweet or heavy component: maximum 20-35% unless justified" — capped at the top of that
// range; excess is redistributed proportionally across the rest of the blend.
const SWEET_HEAVY_MAX_PERCENT = 35;
const SWEET_HEAVY_ROLES = new Set(["Sweetness", "Musk/wood base", "Longevity support"]);

export function computeRatios(roledProducts) {
  const isTwoBalancedFruity = roledProducts.length === 2 && roledProducts.every((p) => p.role === "Main fruit body");
  const parts = isTwoBalancedFruity
    ? roledProducts.map(() => 1)
    : roledProducts.map((p) => ROLE_PARTS[p.role] ?? 1);

  const totalParts = parts.reduce((a, b) => a + b, 0);
  const percentages = parts.map((p) => (p / totalParts) * 100);

  roledProducts.forEach((p, i) => {
    if (SWEET_HEAVY_ROLES.has(p.role) && percentages[i] > SWEET_HEAVY_MAX_PERCENT) {
      const excess = percentages[i] - SWEET_HEAVY_MAX_PERCENT;
      percentages[i] = SWEET_HEAVY_MAX_PERCENT;
      const othersTotal = percentages.reduce((sum, pct, j) => (j === i ? sum : sum + pct), 0);
      if (othersTotal > 0) {
        percentages.forEach((pct, j) => {
          if (j !== i) percentages[j] += (pct / othersTotal) * excess;
        });
      }
    }
  });

  // Ratios must total exactly 100% before ever reaching product creation — round then fix the
  // rounding remainder onto the largest share, rather than letting independent rounding drift.
  const roundedPercent = percentages.map((p) => Math.round(p));
  const percentDiff = 100 - roundedPercent.reduce((a, b) => a + b, 0);
  if (percentDiff !== 0) roundedPercent[roundedPercent.indexOf(Math.max(...roundedPercent))] += percentDiff;

  const rawMl = roundedPercent.map((pct) => (pct / 100) * BOTTLE_ML);
  const roundedMl = rawMl.map((v) => Math.round(v * 10) / 10);
  const mlDiff = Math.round((BOTTLE_ML - roundedMl.reduce((a, b) => a + b, 0)) * 10) / 10;
  if (mlDiff !== 0) {
    const idx = roundedMl.indexOf(Math.max(...roundedMl));
    roundedMl[idx] = Math.round((roundedMl[idx] + mlDiff) * 10) / 10;
  }

  return roledProducts.map((p, i) => ({
    productTitle: p.title,
    parts: parts[i],
    ratioPercent: roundedPercent[i],
    milliliters: roundedMl[i],
  }));
}

// Real catalog products whose family is compatible with at least one of the anchor's own families
// (Phase 6: "compatible supporting products from the notes database"). Compatibility (a genuinely
// DIFFERENT, complementary family — see fragranceCompatibility.js's COMPATIBLE_PAIRS) is the sole
// entry gate; raw note overlap is only a secondary tie-breaker, never enough on its own. An earlier
// version also admitted any product sharing 2+ literal notes with the anchor as a "historical
// co-occurrence" proxy, but verified against real data that let near-identical product-line
// siblings ("Poseidon's Elixir 2.0"/"16A"/"13N") — which share the same family and thus never any
// compatible PAIR — flood the shortlist and crowd out genuinely different, complementary products.
// Same-family siblings fail the compatibleCount>0 gate here and are correctly excluded.
function buildSupportShortlistForAnchor(anchor, allProducts) {
  const anchorFamilies = familiesOf(anchor.orderHistoryNotes);
  const anchorNotes = new Set((anchor.orderHistoryNotes || []).map((n) => String(n).toLowerCase()));

  const scored = [];
  for (const product of allProducts) {
    if (product.normalizedTitle === anchor.normalizedProductName) continue;
    const families = familiesOf(product.notesJson);
    const compatibleCount = anchorFamilies.filter((af) => families.some((f) => pairIsCompatible(af, f))).length;
    if (compatibleCount === 0) continue;
    if (noteOverlapRatio(anchor.orderHistoryNotes, product.notesJson) > NEAR_DUPLICATE_OVERLAP_RATIO) continue;
    const noteOverlap = (product.notesJson || []).filter((n) => anchorNotes.has(String(n).toLowerCase())).length;
    scored.push({ product, compatibleCount, noteOverlap, score: compatibleCount * 5 + noteOverlap });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_SUPPORT_SHORTLIST);
}

// Existing combinations sharing real notes with any product in this proposed combo — "existing
// analogous-combination evidence" (Phase 6), computed from the same in-memory data already loaded
// for this request rather than a fresh DB round trip per candidate.
function findAnalogousCombinations(comboProducts, allCombinations, notesByNormalizedTitle) {
  const comboNotes = new Set(comboProducts.flatMap((p) => (p.notes || []).map((n) => String(n).toLowerCase())));
  const analogous = [];
  for (const combo of allCombinations) {
    const componentNotes = new Set();
    for (const name of Array.isArray(combo.componentProductsJson) ? combo.componentProductsJson : []) {
      (notesByNormalizedTitle.get(normalizeProductName(name)) || []).forEach((n) => componentNotes.add(String(n).toLowerCase()));
    }
    const overlap = [...componentNotes].filter((n) => comboNotes.has(n));
    if (overlap.length >= 2) analogous.push({ title: combo.title, type: combo.type, tagLine: combo.tagLine, overlapCount: overlap.length });
  }
  return analogous.sort((a, b) => b.overlapCount - a.overlapCount).slice(0, 3);
}

function scoreProposedCombination({ comboProducts, type, componentKey, profile, anchor, allCombinations, notesByNormalizedTitle }) {
  // Reject if ANY two products in the combo are near-duplicates of each other (not just of the
  // anchor) — two shortlisted supporting products can each individually pass the anchor's
  // near-duplicate check while being siblings of one another.
  for (let i = 0; i < comboProducts.length; i++) {
    for (let j = i + 1; j < comboProducts.length; j++) {
      if (noteOverlapRatio(comboProducts[i].notes, comboProducts[j].notes) > NEAR_DUPLICATE_OVERLAP_RATIO) return null;
    }
  }

  const { season, likes = [], dislikes = [] } = profile || {};
  const likeFamilies = textToPreferenceFamilies(likes);
  const dislikeFamilies = textToPreferenceFamilies(dislikes);

  // A single high-severity conflicting component disqualifies the whole combination.
  let conflictPenalty = 0;
  for (const p of comboProducts) {
    const conflict = classifyDislikeConflict(p.notes, dislikeFamilies);
    if (conflict.severity === "high") return null;
    if (conflict.severity === "medium") conflictPenalty -= 5;
    if (conflict.severity === "low") conflictPenalty -= 2;
  }

  const roledProducts = assignRoles(comboProducts);
  // "Reject combinations where two or more products have no clear complementary function" — i.e.
  // two or more products with literally no detected family at all, not merely a "Contrast" role
  // assigned on purpose to a genuinely different-direction product.
  if (roledProducts.filter((p) => !p.hasDetectedFamily).length >= 2) return null;

  const risks = assessCombinationRisks(
    comboProducts.map((p) => ({ title: p.title, notes: p.notes })),
    { season },
  );

  let preferenceScore = 0;
  const customerFitReasons = [];
  for (const p of comboProducts) {
    const matches = matchedLikes(p.notes, likeFamilies);
    if (matches.length) {
      preferenceScore += matches.length * SCORE_WEIGHTS.matchesLike;
      customerFitReasons.push(`${p.title} matches your ${matches.join("/")} preference`);
    }
  }

  const seasonalScore = risks.some((r) => r.includes("summer heat")) ? 0 : SCORE_WEIGHTS.sameSeason;

  // Real per-product order-history evidence exists only for the anchor — the one product in this
  // combination that actually came from analyze_customer_product_candidates.
  const historyScore =
    (anchor.sameCityOrders > 0 ? SCORE_WEIGHTS.sameCity : 0) +
    (anchor.sameCountryOrders > 0 ? SCORE_WEIGHTS.sameCountry : 0) +
    (anchor.sameStateOrders > 0 ? SCORE_WEIGHTS.sameStateRegionOrClimate : 0) +
    (anchor.repeatPurchaseCustomers > 0 ? SCORE_WEIGHTS.repeatPurchaseBySimilarCustomer : 0) +
    (anchor.distinctSimilarCustomers >= 5 ? SCORE_WEIGHTS.popularAmongSimilarCustomers : 0);

  // One bonus per PRODUCT PAIR that has at least one compatible family relationship — not one
  // bonus per matching family combination. PREFERENCE_FAMILIES and COMPATIBILITY_TAGS deliberately
  // share keywords (e.g. "fresh" and "citrus" both match "Bergamot"), so a pair of products can
  // each carry several detected tags at once; scoring every cross-product family pairing let a
  // single genuinely-compatible pair rack up double-digit bonuses and let a Quadbrid's 6 product
  // pairs run away to a finalScore in the hundreds regardless of real fit — verified against real
  // data, where four near-identical "Poseidon's Elixir" variants outscored every genuinely
  // different-direction combination this way.
  let compatibilityScore = 0;
  const compatibilityReasons = [];
  for (let i = 0; i < comboProducts.length; i++) {
    for (let j = i + 1; j < comboProducts.length; j++) {
      const famA = familiesOf(comboProducts[i].notes);
      const famB = familiesOf(comboProducts[j].notes);
      const match = famA.flatMap((a) => famB.map((b) => [a, b])).find(([a, b]) => pairIsCompatible(a, b));
      if (match) {
        compatibilityScore += 5;
        compatibilityReasons.push(`${comboProducts[i].title}'s ${match[0]} pairs well with ${comboProducts[j].title}'s ${match[1]}`);
      }
    }
  }

  const analogousExistingCombinations = findAnalogousCombinations(comboProducts, allCombinations, notesByNormalizedTitle);
  const analogousScore = analogousExistingCombinations.length * 2;

  const balanceRiskHit = risks.some((r) => /compete|duplicate|complex/i.test(r));
  const balanceScore = balanceRiskHit ? 0 : 10;

  // Each identified risk (excessive heat, competing fruits, over-complexity, duplicate direction,
  // etc.) is a real, named downside — weighted on the same scale as a dislike conflict (-10/-5) so
  // a risk-laden combination can't out-rank a genuinely clean one just by accumulating small
  // positive signals elsewhere.
  const finalScore =
    preferenceScore + seasonalScore + historyScore + compatibilityScore + analogousScore + balanceScore + conflictPenalty - risks.length * 10;

  let confidence;
  if (finalScore >= 30 && risks.length === 0) confidence = "very high";
  else if (finalScore >= 20 && risks.length <= 1) confidence = "high";
  else if (finalScore >= 10 && risks.length <= 2) confidence = "medium";
  else confidence = "low";

  return {
    products: roledProducts.map((p) => ({ title: p.title, notes: p.notes, fragranceFamily: null, contribution: p.role })),
    type,
    canonicalKey: componentKey,
    existsAlready: false,
    preferenceScore,
    seasonalScore,
    historyScore,
    compatibilityScore,
    balanceScore,
    conflictPenalty,
    finalScore,
    mainDirection: [...new Set(roledProducts.map((p) => p.role))].join(" + "),
    compatibilityReasons,
    customerFitReasons,
    historicalEvidence: {
      sameCityOrders: anchor.sameCityOrders,
      sameStateOrders: anchor.sameStateOrders,
      sameCountryOrders: anchor.sameCountryOrders,
      sameSeasonOrders: anchor.sameSeasonOrders,
      distinctSimilarCustomers: anchor.distinctSimilarCustomers,
      repeatPurchaseCustomers: anchor.repeatPurchaseCustomers,
    },
    analogousExistingCombinations,
    risks,
    confidence,
    recommendedRatio: computeRatios(roledProducts),
  };
}

/**
 * @param {object} args
 * @param {object} args.profile - CustomerFragranceProfile-shaped (season, likes, dislikes used here).
 * @param {Array} args.candidateProducts - ProductCandidate[] from analyzeCustomerProductCandidates.
 * @param {number} [args.maximumResults]
 * @param {string[]} [args.allowedTypes] - subset of ["HYBRID","TRIBRID","QUADBRID"].
 */
export async function generateNewProductCombinations({ profile, candidateProducts, maximumResults = DEFAULT_MAX_RESULTS, allowedTypes = ALL_TYPES }) {
  const anchors = (candidateProducts || [])
    .slice()
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, MAX_ANCHORS);
  if (!anchors.length) return [];

  const [allProducts, allCombinations] = await Promise.all([
    prisma.fragranceProduct.findMany({ select: { title: true, normalizedTitle: true, notesJson: true } }),
    prisma.existingCombination.findMany({ select: { title: true, type: true, componentProductsJson: true, tagLine: true, componentKey: true } }),
  ]);
  const notesByNormalizedTitle = new Map(allProducts.map((p) => [p.normalizedTitle, p.notesJson || []]));
  // Loaded once, checked in-memory per candidate combo below — avoids one DB round trip per
  // candidate (with up to ~450 candidate combos generated per request, that was the dominant cost
  // in testing before this fix).
  const existingComponentKeys = new Set(allCombinations.map((c) => c.componentKey));

  const results = [];
  const seenComponentKeys = new Set();

  for (const anchor of anchors) {
    const shortlist = buildSupportShortlistForAnchor(anchor, allProducts);
    if (!shortlist.length) continue;

    for (const type of allowedTypes) {
      const supportCount = (COMPONENT_COUNT_BY_TYPE[type] ?? 0) - 1;
      if (supportCount < 1 || supportCount > shortlist.length) continue;

      for (const supportCombo of combinationsOf(shortlist, supportCount)) {
        const comboProducts = [
          { title: anchor.productName, notes: anchor.orderHistoryNotes },
          ...supportCombo.map((s) => ({ title: s.product.title, notes: s.product.notesJson || [] })),
        ];
        const componentKey = createCombinationKey(comboProducts.map((p) => p.title));
        if (seenComponentKeys.has(componentKey)) continue;
        seenComponentKeys.add(componentKey);

        // Spec: only recommend combinations that do NOT already exist as an exact Hybrid/Tribrid/
        // Quadbrid in the imported combination database.
        if (existingComponentKeys.has(componentKey)) continue;

        const proposal = scoreProposedCombination({
          comboProducts,
          type,
          componentKey,
          profile,
          anchor,
          allCombinations,
          notesByNormalizedTitle,
        });
        if (proposal) results.push(proposal);
      }
    }
  }

  results.sort((a, b) => b.finalScore - a.finalScore);
  return results.slice(0, maximumResults);
}
