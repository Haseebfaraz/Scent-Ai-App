// Phase 3 — deterministic product-candidate scoring backing the analyze_customer_product_candidates
// tool. Every number here comes from real Prisma aggregation (SQL-side, per Phase 12's performance
// requirement) — never a full-table JavaScript scan, and never a score invented by the language
// model.
//
// Country/state/season/classification tiers read from ProductRegionSummary (precomputed by
// scripts/build-region-summary.cjs) rather than live-aggregating OrderHistory — a live groupBy
// scoped to country="United States" (87% of the 936,819-row table) measured ~12s per query in
// testing. City tier stays live: a single real city's row count is always small (thousands, not
// hundreds of thousands), so it's fast without precomputing.
import prisma from "../db.server.js";
import { SEASON_ALIASES } from "../utils/fragranceNormalization.js";
import { SCORE_WEIGHTS, classifyDislikeConflict, matchedLikes, computeEvidenceLevel } from "../utils/fragranceScoring.js";
import { textToPreferenceFamilies } from "../utils/fragranceCompatibility.js";

// Matches the MIN_SAMPLE_SIZE convention already established in app/routes/chat.jsx's
// getPopularNotesForRegion — a regional signal only counts once it's backed by a real sample.
const MIN_SAMPLE_SIZE = 20;
// Bounded shortlist per region tier — the candidate pool is a union of each tier's top products,
// never every distinct product in the table, so downstream per-candidate queries stay small.
const CANDIDATE_SHORTLIST_PER_TIER = 20;
// Spec: "return no more than 10 product candidates."
const MAX_CANDIDATES_RETURNED = 10;
// "Popular among similar customers" (breadth signal) is distinguished from "repeat purchase by a
// similar customer" (loyalty signal, one customer buying it more than once) by requiring several
// distinct customers in the region, not just one.
const POPULARITY_THRESHOLD = 5;

// ---- City tier (live — always a small, fast partition of the table) ----

async function topProductsByCityLive(cityWhere, limit) {
  if (!cityWhere) return [];
  const rows = await prisma.orderHistory.groupBy({
    by: ["normalizedProductName"],
    where: { ...cityWhere, normalizedProductName: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { normalizedProductName: "desc" } },
    take: limit,
  });
  return rows.map((r) => r.normalizedProductName);
}

async function cityCountsByProduct(cityWhere, candidateNames) {
  if (!cityWhere || !candidateNames.length) return new Map();
  const rows = await prisma.orderHistory.groupBy({
    by: ["normalizedProductName"],
    where: { ...cityWhere, normalizedProductName: { in: candidateNames } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.normalizedProductName, r._count._all]));
}

// ---- Country/state/season tiers (precomputed — indexed point-reads, not live aggregation) ----

async function topProductsFromSummary(scope, scopeValue, limit) {
  if (!scopeValue) return [];
  const rows = await prisma.productRegionSummary.findMany({
    where: { scope, scopeValue },
    orderBy: { orderCount: "desc" },
    take: limit,
    select: { normalizedProductName: true },
  });
  return rows.map((r) => r.normalizedProductName);
}

async function summaryByProduct(scope, scopeValue, candidateNames) {
  if (!scopeValue || !candidateNames.length) return new Map();
  const rows = await prisma.productRegionSummary.findMany({
    where: { scope, scopeValue, normalizedProductName: { in: candidateNames } },
    select: { normalizedProductName: true, orderCount: true, distinctCustomerCount: true, repeatCustomerCount: true },
  });
  return new Map(rows.map((r) => [r.normalizedProductName, r]));
}

// "Similar customer" evidence (distinct/repeat counts) scoped to the narrowest sufficient region —
// city if it clears MIN_SAMPLE_SIZE (live, fast, more meaningfully "similar" than a whole country),
// else the precomputed state tier, else the precomputed country tier.
async function resolveCohortEvidence({ cityWhere, stateRegion, country, candidateNames }) {
  if (cityWhere) {
    const cityOrderCount = await prisma.orderHistory.count({ where: cityWhere });
    if (cityOrderCount >= MIN_SAMPLE_SIZE) {
      const rows = await prisma.orderHistory.groupBy({
        by: ["normalizedProductName", "customerKeyHash"],
        where: { ...cityWhere, normalizedProductName: { in: candidateNames }, customerKeyHash: { not: null } },
        _count: { _all: true },
      });
      const distinct = new Map();
      const repeat = new Map();
      for (const row of rows) {
        const name = row.normalizedProductName;
        distinct.set(name, (distinct.get(name) || 0) + 1);
        if (row._count._all > 1) repeat.set(name, (repeat.get(name) || 0) + 1);
      }
      return { distinct, repeat };
    }
  }
  const tierScope = stateRegion ? "state" : country ? "country" : null;
  const tierValue = stateRegion || country || null;
  const summary = await summaryByProduct(tierScope, tierValue, candidateNames);
  const distinct = new Map();
  const repeat = new Map();
  for (const [name, row] of summary) {
    distinct.set(name, row.distinctCustomerCount);
    repeat.set(name, row.repeatCustomerCount);
  }
  return { distinct, repeat };
}

/**
 * @param {object} profile - CustomerFragranceProfile-shaped: { city, stateRegion, country, season,
 *   likes: string[], dislikes: string[] }. All location fields are expected to already be
 *   confirmed/normalized real values (see resolveLocationInput) — this function does no location
 *   fuzzing itself.
 * @returns {Promise<Array>} up to MAX_CANDIDATES_RETURNED ProductCandidate objects.
 */
export async function analyzeCustomerProductCandidates(profile) {
  const { city, stateRegion, country, season, likes = [], dislikes = [] } = profile || {};

  const cityWhere = city ? { city } : null;
  const seasonValues = season && SEASON_ALIASES[season] ? SEASON_ALIASES[season] : null;

  const [cityTop, stateTop, countryTop, seasonTop] = await Promise.all([
    topProductsByCityLive(cityWhere, CANDIDATE_SHORTLIST_PER_TIER),
    topProductsFromSummary("state", stateRegion, CANDIDATE_SHORTLIST_PER_TIER),
    topProductsFromSummary("country", country, CANDIDATE_SHORTLIST_PER_TIER),
    topProductsFromSummary("season", season, CANDIDATE_SHORTLIST_PER_TIER),
  ]);
  const candidateNames = [...new Set([...cityTop, ...stateTop, ...countryTop, ...seasonTop])];
  if (!candidateNames.length) return [];

  const [cityCounts, stateSummary, countrySummary, seasonSummary, classificationRows, cohort, products] = await Promise.all([
    cityCountsByProduct(cityWhere, candidateNames),
    summaryByProduct("state", stateRegion, candidateNames),
    summaryByProduct("country", country, candidateNames),
    summaryByProduct("season", season, candidateNames),
    prisma.productRegionSummary.findMany({
      where: { scope: "classification_global", normalizedProductName: { in: candidateNames } },
      select: { normalizedProductName: true, scopeValue: true, orderCount: true },
    }),
    resolveCohortEvidence({ cityWhere, stateRegion, country, candidateNames }),
    prisma.fragranceProduct.findMany({
      where: { normalizedTitle: { in: candidateNames } },
      select: { title: true, normalizedTitle: true, notesJson: true },
    }),
  ]);

  const topClassificationByProduct = new Map();
  for (const row of classificationRows) {
    const current = topClassificationByProduct.get(row.normalizedProductName);
    if (!current || row.orderCount > current.orderCount) {
      topClassificationByProduct.set(row.normalizedProductName, { classification: row.scopeValue, orderCount: row.orderCount });
    }
  }
  const productByNormalizedTitle = new Map(products.map((p) => [p.normalizedTitle, p]));

  const likeFamilies = textToPreferenceFamilies(likes);
  const dislikeFamilies = textToPreferenceFamilies(dislikes);

  const candidates = [];
  for (const normalizedProductName of candidateNames) {
    // A product only counts as a real candidate if it's actually in our verified catalog — never
    // score or recommend a name that only exists as raw (possibly messy) order-history text.
    const product = productByNormalizedTitle.get(normalizedProductName);
    if (!product) continue;

    const notes = Array.isArray(product.notesJson) ? product.notesJson : [];
    const sameCityOrders = cityCounts.get(normalizedProductName) || 0;
    const sameStateOrders = stateSummary.get(normalizedProductName)?.orderCount || 0;
    const sameCountryOrders = countrySummary.get(normalizedProductName)?.orderCount || 0;
    const sameSeasonOrders = seasonSummary.get(normalizedProductName)?.orderCount || 0;
    const distinctSimilarCustomers = cohort.distinct.get(normalizedProductName) || 0;
    const repeatPurchaseCustomers = cohort.repeat.get(normalizedProductName) || 0;

    const preferenceMatches = matchedLikes(notes, likeFamilies);
    const dislikeConflict = classifyDislikeConflict(notes, dislikeFamilies);

    // Spec: "Products with a high conflict should normally be excluded."
    if (dislikeConflict.severity === "high") continue;

    let relevanceScore = 0;
    if (sameCityOrders > 0) relevanceScore += SCORE_WEIGHTS.sameCity;
    if (sameCountryOrders > 0) relevanceScore += SCORE_WEIGHTS.sameCountry;
    if (sameStateOrders > 0) relevanceScore += SCORE_WEIGHTS.sameStateRegionOrClimate;
    if (sameSeasonOrders > 0) relevanceScore += SCORE_WEIGHTS.sameSeason;
    relevanceScore += preferenceMatches.length * SCORE_WEIGHTS.matchesLike;
    relevanceScore += dislikeConflict.matchedFamilies.length * SCORE_WEIGHTS.conflictsDislike;
    if (repeatPurchaseCustomers > 0) relevanceScore += SCORE_WEIGHTS.repeatPurchaseBySimilarCustomer;
    if (distinctSimilarCustomers >= POPULARITY_THRESHOLD) relevanceScore += SCORE_WEIGHTS.popularAmongSimilarCustomers;

    candidates.push({
      productName: product.title,
      normalizedProductName,
      relevanceScore,
      sameCityOrders,
      sameStateOrders,
      sameCountryOrders,
      sameSeasonOrders,
      distinctSimilarCustomers,
      repeatPurchaseCustomers,
      preferenceMatches,
      dislikeConflicts: dislikeConflict.matchedFamilies,
      classification: topClassificationByProduct.get(normalizedProductName)?.classification || null,
      orderHistoryNotes: notes,
      evidenceLevel: computeEvidenceLevel({ distinctSimilarCustomers, sameSeasonOrders }),
    });
  }

  // Tie-break by total real order-count evidence, per spec ("use counts and purchase volume as
  // ranking tie-breakers"), never by re-multiplying the score itself.
  candidates.sort((a, b) => {
    if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
    const aVolume = a.sameCityOrders + a.sameStateOrders + a.sameCountryOrders + a.sameSeasonOrders;
    const bVolume = b.sameCityOrders + b.sameStateOrders + b.sameCountryOrders + b.sameSeasonOrders;
    return bVolume - aVolume;
  });

  return candidates.slice(0, MAX_CANDIDATES_RETURNED);
}
