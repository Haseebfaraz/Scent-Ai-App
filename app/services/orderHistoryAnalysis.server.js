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
import { SCORE_WEIGHTS, classifyDislikeConflict, matchedLikes, computeEvidenceLevel, likeMatchStrength } from "../utils/fragranceScoring.js";
import {
  textToPreferenceFamilies, interpretCustomerPreferences, passesIntensityFilter,
  interpretLifestyleContext, countPreferredDirectionMatches,
  literalNoteTermsFromLikes, literalNoteMatchCount,
} from "../utils/fragranceCompatibility.js";

// Matches the MIN_SAMPLE_SIZE convention already established in app/routes/chat.jsx's
// getPopularNotesForRegion — a regional signal only counts once it's backed by a real sample.
const MIN_SAMPLE_SIZE = 20;
// Bounded shortlist per region tier — the candidate pool is a union of each tier's top products,
// never every distinct product in the table, so downstream per-candidate queries stay small.
const CANDIDATE_SHORTLIST_PER_TIER = 20;
// Fix (candidate pool ignored likes) — raised from the spec's original 10 now that a genuine third
// source (like-matched, not just regionally-popular) feeds into the same pool below; a slightly
// larger final list gives real preference-driven candidates room to actually compete for one of the
// MAX_ANCHORS slots instead of getting crowded out by the regional-popularity tiers alone.
const MAX_CANDIDATES_RETURNED = 15;
// Bounded shortlist for the like-matched tier (see topProductsByLikeMatch below) — same purpose as
// CANDIDATE_SHORTLIST_PER_TIER, just for a tier ranked by preference-match strength instead of
// order counts.
const LIKE_MATCH_SHORTLIST = 20;
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

// ---- Preference-match tier (real catalog, ranked by how much it reflects stated likes) ----

// Fix (candidate pool ignored likes) — every tier above comes purely from regional popularity;
// a genuinely well-matching product that isn't already a regional bestseller could never even be
// CONSIDERED, only ever re-ranked within an already-fixed, popularity-only pool — confirmed live:
// the same handful of "regionally popular" anchors kept winning regardless of what a customer
// actually said they liked (e.g. "Fruity, Fresh, Apple, Strawberry, Peach" produced the identical
// oud/musk-heavy anchors as a customer who only said "Sweet"). This queries the real catalog
// directly and ranks by likeMatchStrength (how much of each product's real notes reflect the
// customer's BEST-matching liked family, not just whether any family matches at all — same measure
// already used to weight preferenceScore in recommendationEngine.server.js) — merged into the same
// candidateNames pool below, so a fruity/fresh product gets a real shot at becoming an anchor even
// with zero regional order history, instead of being excluded before relevanceScore ever runs.
// Fix (literal note terms lost to family-level matching) — `strength` alone treats a product built
// from Apple/Pear/Blackcurrant as equally "fruity" as one containing the customer's actual named
// notes (e.g. real Peach). `literalTerms` (from literalNoteTermsFromLikes) breaks that tie: each
// literal match adds a fixed boost, so a genuinely-named-note product is never crowded out of the
// LIKE_MATCH_SHORTLIST by an equally-dominant but differently-fruited one.
const LITERAL_MATCH_BOOST = 0.5;

async function topProductsByLikeMatch(likeFamilies, literalTerms = []) {
  if (!likeFamilies.length) return [];
  const allProducts = await prisma.fragranceProduct.findMany({
    select: { normalizedTitle: true, notesJson: true },
  });
  return allProducts
    .map((p) => {
      const notes = Array.isArray(p.notesJson) ? p.notesJson : [];
      const strength = Math.max(0, ...likeFamilies.map((family) => likeMatchStrength(notes, family)));
      const rank = strength + LITERAL_MATCH_BOOST * literalNoteMatchCount(notes, literalTerms);
      return { normalizedTitle: p.normalizedTitle, strength, rank };
    })
    .filter((p) => p.strength > 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, LIKE_MATCH_SHORTLIST)
    .map((p) => p.normalizedTitle);
}

// ---- Country/state/season tiers (precomputed — indexed point-reads, not live aggregation) ----

// Fix (season-alias bug) — `scopeValue` may be a single string (state/country: no aliasing) OR an
// array (season: the source `season` column has inconsistent real values — "Summer"/"Summer
// Months", "Fall"/"Autumn Months" — see SEASON_ALIASES; scripts/build-region-summary.cjs stores
// each raw value as its OWN scopeValue row, un-normalized). Confirmed a real bug here: this
// function used to be called with the single raw `season` string, silently missing every row
// stored under an alias spelling. Passing the full alias array and matching with `in` fixes it.
function scopeValueWhere(scopeValue) {
  return Array.isArray(scopeValue) ? { in: scopeValue } : scopeValue;
}

async function topProductsFromSummary(scope, scopeValue, limit) {
  if (!scopeValue || (Array.isArray(scopeValue) && !scopeValue.length)) return [];
  const rows = await prisma.productRegionSummary.findMany({
    where: { scope, scopeValue: scopeValueWhere(scopeValue) },
    orderBy: { orderCount: "desc" },
    take: limit,
    select: { normalizedProductName: true },
  });
  return rows.map((r) => r.normalizedProductName);
}

async function summaryByProduct(scope, scopeValue, candidateNames) {
  if (!scopeValue || (Array.isArray(scopeValue) && !scopeValue.length) || !candidateNames.length) return new Map();
  const rows = await prisma.productRegionSummary.findMany({
    where: { scope, scopeValue: scopeValueWhere(scopeValue), normalizedProductName: { in: candidateNames } },
    select: { normalizedProductName: true, orderCount: true, distinctCustomerCount: true, repeatCustomerCount: true },
  });
  // Multiple alias rows (e.g. "Summer" + "Summer Months") can both match one product — combine
  // them into a single real total rather than keeping only whichever alias happened to load last.
  const combined = new Map();
  for (const row of rows) {
    const existing = combined.get(row.normalizedProductName);
    if (!existing) {
      combined.set(row.normalizedProductName, { ...row });
    } else {
      existing.orderCount += row.orderCount;
      existing.distinctCustomerCount += row.distinctCustomerCount;
      existing.repeatCustomerCount += row.repeatCustomerCount;
    }
  }
  return combined;
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
  // Computed here (not further down with dislikeFamilies below) specifically so the like-matched
  // tier can use it — see topProductsByLikeMatch's own comment for why this tier exists.
  const likeFamiliesForCandidates = textToPreferenceFamilies(likes);
  const literalLikeTerms = literalNoteTermsFromLikes(likes);

  const [cityTop, stateTop, countryTop, seasonTop, likeMatchTop] = await Promise.all([
    topProductsByCityLive(cityWhere, CANDIDATE_SHORTLIST_PER_TIER),
    topProductsFromSummary("state", stateRegion, CANDIDATE_SHORTLIST_PER_TIER),
    topProductsFromSummary("country", country, CANDIDATE_SHORTLIST_PER_TIER),
    topProductsFromSummary("season", seasonValues, CANDIDATE_SHORTLIST_PER_TIER),
    topProductsByLikeMatch(likeFamiliesForCandidates, literalLikeTerms),
  ]);
  const candidateNames = [...new Set([...cityTop, ...stateTop, ...countryTop, ...seasonTop, ...likeMatchTop])];
  if (!candidateNames.length) return [];

  const [cityCounts, stateSummary, countrySummary, seasonSummary, classificationRows, cohort, products] = await Promise.all([
    cityCountsByProduct(cityWhere, candidateNames),
    summaryByProduct("state", stateRegion, candidateNames),
    summaryByProduct("country", country, candidateNames),
    summaryByProduct("season", seasonValues, candidateNames),
    prisma.productRegionSummary.findMany({
      where: { scope: "classification_global", normalizedProductName: { in: candidateNames } },
      select: { normalizedProductName: true, scopeValue: true, orderCount: true },
    }),
    resolveCohortEvidence({ cityWhere, stateRegion, country, candidateNames }),
    prisma.fragranceProduct.findMany({
      where: { normalizedTitle: { in: candidateNames } },
      select: { title: true, normalizedTitle: true, notesJson: true, collection: true },
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

  const likeFamilies = likeFamiliesForCandidates;
  const dislikeFamilies = textToPreferenceFamilies(dislikes);
  // Fix (Aniq spec, sections 2/4) — a customer's free-text sensitivity/style signals now become a
  // real, deterministic pre-generation filter at the candidate-scoring stage itself, not just at
  // final combination scoring — a highly sensitive customer never even sees an intense product as
  // a candidate to begin with.
  const preferenceIntent = interpretCustomerPreferences(profile);
  // Fix (lifestyle scoring) — lifestyle must affect candidate ranking too, not just combination
  // ranking and copy — a small per-candidate bonus, same weighted-intersection directions used at
  // the combination stage.
  const lifestyleContext = interpretLifestyleContext(profile);

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
    // Fix (Aniq spec) — a hard pre-generation exclusion for a highly sensitive customer.
    if (!passesIntensityFilter(notes, preferenceIntent)) continue;

    let relevanceScore = 0;
    if (sameCityOrders > 0) relevanceScore += SCORE_WEIGHTS.sameCity;
    if (sameCountryOrders > 0) relevanceScore += SCORE_WEIGHTS.sameCountry;
    if (sameStateOrders > 0) relevanceScore += SCORE_WEIGHTS.sameStateRegionOrClimate;
    if (sameSeasonOrders > 0) relevanceScore += SCORE_WEIGHTS.sameSeason;
    relevanceScore += preferenceMatches.length * SCORE_WEIGHTS.matchesLike;
    // Fix (literal note terms lost to family-level matching) — same tie-breaker as
    // topProductsByLikeMatch above, applied to the final ranking so a candidate genuinely containing
    // the customer's named notes (not just the broader family) is more likely to make the top
    // MAX_CANDIDATES_RETURNED / become an anchor, not just get into the shortlist.
    relevanceScore += literalNoteMatchCount(notes, literalLikeTerms) * SCORE_WEIGHTS.matchesLike * LITERAL_MATCH_BOOST;
    relevanceScore += dislikeConflict.matchedFamilies.length * SCORE_WEIGHTS.conflictsDislike;
    if (repeatPurchaseCustomers > 0) relevanceScore += SCORE_WEIGHTS.repeatPurchaseBySimilarCustomer;
    if (distinctSimilarCustomers >= POPULARITY_THRESHOLD) relevanceScore += SCORE_WEIGHTS.popularAmongSimilarCustomers;

    // Fix (lifestyle scoring) — a small real bonus per matched lifestyle-preferred direction,
    // weighted the same way the combination stage weights simultaneous lifestyles, so a product
    // whose real notes fit the customer's stated lifestyle(s) ranks higher as a candidate too.
    for (const [direction, weight] of lifestyleContext.preferredDirections) {
      if (countPreferredDirectionMatches(notes, [direction]) > 0) relevanceScore += 2 * weight;
    }

    candidates.push({
      productName: product.title,
      normalizedProductName,
      collection: product.collection,
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
