// Phase 6/7 — generate_new_product_combinations. Builds NEW Hybrid/Tribrid/Quadbrid proposals from
// real catalog products, scores them on the spec's compatibility dimensions, and computes
// deterministic mixing ratios. Never proposes a combination already present in ExistingCombination
// (checked via the same canonical componentKey used everywhere else), and never invents a product,
// note, or ratio — every number here is either a real per-product order-history count (passed in
// via candidateProducts, from analyzeCustomerProductCandidates) or derived from real
// FragranceProduct.notesJson.
//
// Fix 3/4 (real transcript bugs): every proposal is split into `internalProducts` (real source
// titles/notes/ratios — used only for Shopify product creation and backend analysis, NEVER sent to
// the frontend or the model's customer-facing narration) and a set of `customerFacing*` fields
// (name, description, best use, weather suitability, strength, risk) generated deterministically
// from real data, with no source product name in any of them. A hard shape validation
// (validateCombinationShape) runs on every proposal before it's ever returned, so a "combination"
// with one product, a duplicate product, or a 100%-one-product ratio is structurally impossible —
// this closes the "Casino Elixir — 100%" bug regardless of how such a shape could arise.
import prisma from "../db.server.js";
import { createCombinationKey } from "../utils/combinationKey.js";
import { normalizeProductName } from "../utils/fragranceNormalization.js";
import {
  PREFERENCE_FAMILIES,
  COMPATIBILITY_TAGS,
  detectFamilies,
  pairIsCompatible,
  assessCombinationRisks,
  assessCombinationRiskDetails,
  textToPreferenceFamilies,
  interpretCustomerPreferences,
  interpretLifestyleContext,
  computeComplexityLevel,
  detectIntensityDrivers,
  detectSofteningNotes,
  passesIntensityFilter,
  countPreferredDirectionMatches,
  countAvoidedDirectionMatches,
  literalNoteTermsFromLikes,
  literalNoteMatchCount,
  exactNoteCoverageScore,
  matchedLiteralTerms,
  missingLiteralTerms,
  splitDislikesByExactness,
} from "../utils/fragranceCompatibility.js";
import { SCORE_WEIGHTS, classifyDislikeConflict, matchedLikes, likeMatchStrength } from "../utils/fragranceScoring.js";
import { describeCharacter, directionForRole, pickWords, DIRECTION_VOCABULARY } from "../utils/fragranceVocabulary.js";
import { hasSeasonWeatherConflict } from "../utils/weatherSeason.js";
import { applyCustomerFacingCopy } from "./fragranceCopyGeneration.server.js";

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

// Fix (perf) — allProducts/allCombinations are near-static reference tables (~3450 / ~432 rows)
// that were being fetched fresh, unconditionally, on EVERY call to generateNewProductCombinations
// (including every refine_combination_recommendations call in the same conversation) — a full
// table scan regardless of how rich or thin the customer's profile is. Cached at module scope,
// same pattern as chat.jsx's own cachedCatalogTitlePatterns cache, but with a TTL rather than a
// permanent cache: verified nothing in the live running app writes to FragranceProduct or
// ExistingCombination — only the offline scripts/*.cjs import scripts do, and those run as a
// SEPARATE process against the same database, so there is no in-process "a row was just written"
// event this module could ever hook an invalidation into. A short TTL is the only mechanism that
// can notice a catalog re-import that happened while the server was already running, and 5 minutes
// is far shorter than the gap between real catalog updates (a manual, infrequent operation) while
// still eliminating the round trip for every tool call within one live conversation.
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
let catalogCache = null; // { allProducts, allCombinations, fetchedAt }

async function getCatalogAndCombinations() {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return catalogCache;
  }
  const [allProducts, allCombinations] = await Promise.all([
    prisma.fragranceProduct.findMany({ select: { title: true, normalizedTitle: true, notesJson: true, collection: true } }),
    prisma.existingCombination.findMany({ select: { title: true, normalizedTitle: true, type: true, componentProductsJson: true, tagLine: true, componentKey: true } }),
  ]);
  catalogCache = { allProducts, allCombinations, fetchedAt: Date.now() };
  return catalogCache;
}

const ALL_FAMILIES = { ...PREFERENCE_FAMILIES, ...COMPATIBILITY_TAGS };

function familiesOf(notes) {
  return detectFamilies(notes, ALL_FAMILIES);
}

// Fix (refinement "remove X" didn't actually remove X) — a customer's stated profile dislike is
// deliberately a SOFT signal (spec: "don't reject a product for one minor supporting note unless
// the conflict is substantial" — classifyDislikeConflict's per-component severity system, untouched
// by this). Confirmed live: that softness let a single incidental "Sandalwood" trace, buried deep in
// a shared support component, survive a refinement asking to remove it — the same two top-ranked
// combos won again, unchanged. A refinement's OWN freshly-named exclusion is a stronger, more
// immediate signal ("get rid of this, now, for this result") than a general profile dislike, so it
// hard-excludes ANY product containing so much as a trace of the family — scoped ONLY to the
// family(ies) named in THIS refinement turn (hardExcludeFamilies), never the customer's whole
// dislike history, which keeps the existing softer behavior exactly as before.
export function hasHardExcludedFamily(notes, hardExcludeFamilies) {
  if (!hardExcludeFamilies?.length) return false;
  return detectFamilies(notes, PREFERENCE_FAMILIES).some((f) => hardExcludeFamilies.includes(f));
}

// Fix (refinement couldn't exclude a note with no family at all) — hardExcludeFamilies above only
// ever catches a named note if it happens to live in a PREFERENCE_FAMILIES keyword list; a real
// catalog note with no family entry (e.g. "Jackfruit", "Griotte Syrup") matched nothing there no
// matter how clearly the customer named it. Reuses literalNoteMatchCount (the same whole-word
// mechanism preference scoring already trusts for literal terms) to hard-exclude directly by name,
// alongside hasHardExcludedFamily rather than instead of it — both run as an OR (see isHardExcluded
// below), so a name that DOES belong to a family still gets that family's existing broader
// exclusion (e.g. "sandalwood" still excludes the whole woody family, unchanged from before).
export function hasHardExcludedTerm(notes, hardExcludeTerms) {
  return literalNoteMatchCount(notes, hardExcludeTerms) > 0;
}

function isHardExcluded(notes, hardExcludeFamilies, hardExcludeTerms) {
  return hasHardExcludedFamily(notes, hardExcludeFamilies) || hasHardExcludedTerm(notes, hardExcludeTerms);
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

// Fix 7 (Aniq spec) — a plain top-N slice let the same 1-2 anchor products dominate an entire
// batch (confirmed against real production data: 8 "different" recommendations sharing one
// anchor). Greedy walk over the already score-sorted list: skip a candidate once its anchor has
// been used MAX_PER_ANCHOR times, or any single product has appeared MAX_PRODUCT_APPEARANCES times
// across the accepted set. Backfills from skipped candidates (still in score order) if diversity
// constraints would otherwise return fewer than requested — a thin real candidate pool should
// never silently shrink the result count, only reorder it.
const MAX_PER_ANCHOR = 2;
const MAX_PRODUCT_APPEARANCES = 3;
function selectDiverseResults(sortedResults, maximumResults) {
  const accepted = [];
  const skipped = [];
  const anchorCounts = new Map();
  const productCounts = new Map();

  for (const result of sortedResults) {
    if (accepted.length >= maximumResults) break;
    const normalizedTitles = result.internalProducts.map((p) => normalizeProductName(p.title));
    const anchorTitle = normalizedTitles[0];
    const anchorCount = anchorCounts.get(anchorTitle) || 0;
    const productWouldOverflow = normalizedTitles.some((t) => (productCounts.get(t) || 0) >= MAX_PRODUCT_APPEARANCES);

    if (anchorCount >= MAX_PER_ANCHOR || productWouldOverflow) {
      skipped.push(result);
      continue;
    }
    accepted.push(result);
    anchorCounts.set(anchorTitle, anchorCount + 1);
    normalizedTitles.forEach((t) => productCounts.set(t, (productCounts.get(t) || 0) + 1));
  }

  for (const result of skipped) {
    if (accepted.length >= maximumResults) break;
    accepted.push(result);
  }
  return accepted;
}

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

// Fix (role misclassification) — this used to pick whichever family appeared FIRST in
// FAMILY_ROLE_PRIORITY that matched ANY note at all. Since "fresh" is checked first and citrus/mint
// notes are common accents even in heavy, gourmand, or woody products, a single stray "Peppermint"
// or "Mandarin Orange" note was enough to label an overwhelmingly heavy component "Freshness" —
// confirmed live: a Quadbrid combining a gourmand anchor with three complex, mostly woody/spicy/
// musky support products had ALL FOUR labeled "(Freshness)", which also silently broke the ratio
// math (computeRatios weights every "Freshness" role identically, so all four landed on the same
// meaningless 25%/25%/25%/25% split instead of one reflecting their real, different characters).
// Role is now whichever family has the MOST matching real notes overall, not just the first one
// present — e.g. Burlington Gardens' 6 woody/musk/amber notes now correctly outweigh its 5 fresh
// ones. Ties still resolve by FAMILY_ROLE_PRIORITY's existing order (first-listed role wins).
function dominantRole(notes) {
  const list = Array.isArray(notes) ? notes : [];
  const countsByRole = {};
  for (const [family, role] of FAMILY_ROLE_PRIORITY) {
    const keywords = ALL_FAMILIES[family];
    if (!keywords) continue;
    const count = list.filter((note) => {
      const lower = String(note).toLowerCase();
      return keywords.some((kw) => lower.includes(kw));
    }).length;
    countsByRole[role] = (countsByRole[role] || 0) + count;
  }
  let bestRole = null;
  let bestCount = 0;
  for (const [role, count] of Object.entries(countsByRole)) {
    if (count > bestCount) {
      bestCount = count;
      bestRole = role;
    }
  }
  return bestRole;
}

// Fix 6 (multi-dimensional roles) — a product is classified from its COMPLETE note list, not just
// whichever family matches first. `role`/`hasDetectedFamily` are kept exactly as before (the ratio
// math in computeRatios and existing tests key off `.role`'s exact string) — this is additive:
// `secondaryRoles` (every OTHER matched family besides the primary), `intensityDrivers` (real
// matched risk-note keywords, e.g. "royal chariot attar" surfaces ["cardamom","pepper","patchouli",
// "guaiac"] instead of being flattened into a single "Freshness" label), `softeningNotes`, and
// `complexityLevel` (from the product's real note count). A product with many real notes spanning
// several directions (Royal Chariot Attar: bergamot/mandarin + cardamom/pepper + patchouli/guaiac +
// sandalwood/vanilla) is now visibly complex and multi-directional instead of disappearing into one
// bucket.
export function assignRoles(comboProducts) {
  return comboProducts.map((p) => {
    const families = familiesOf(p.notes);
    const role = dominantRole(p.notes);
    const primaryFamily = role ? FAMILY_ROLE_PRIORITY.find(([, r]) => r === role)?.[0] : null;
    return {
      ...p,
      role: role || "Contrast",
      hasDetectedFamily: families.length > 0,
      secondaryRoles: families.filter((f) => f !== primaryFamily),
      intensityDrivers: detectIntensityDrivers(p.notes),
      softeningNotes: detectSofteningNotes(p.notes),
      complexityLevel: computeComplexityLevel((p.notes || []).length),
    };
  });
}

// Fix 4 — the deterministic shape gate the spec's own example code calls for. Runs on every
// proposal before it's ever returned or saved, so "a combination" with the wrong product count, a
// duplicate product, or a 100%-one-product ratio is structurally impossible regardless of what
// generated it.
export function validateCombinationShape({ type, products, recommendedRatio }) {
  const expectedCount = COMPONENT_COUNT_BY_TYPE[type];
  if (!expectedCount) {
    throw new Error(`Unknown combination type "${type}" — must be HYBRID, TRIBRID, or QUADBRID.`);
  }
  const uniqueTitles = new Set((products || []).map((p) => normalizeProductName(p.title)));
  if (uniqueTitles.size !== expectedCount || (products || []).length !== expectedCount) {
    throw new Error(
      `A ${type} must contain exactly ${expectedCount} distinct source products (got ${(products || []).length}, ${uniqueTitles.size} distinct).`,
    );
  }
  if (Array.isArray(recommendedRatio)) {
    if (recommendedRatio.some((r) => r.ratioPercent >= 100)) {
      throw new Error("No single product may be assigned 100% of a custom combination.");
    }
    const pctSum = recommendedRatio.reduce((s, r) => s + r.ratioPercent, 0);
    if (pctSum !== 100) {
      throw new Error(`Ratios must sum to 100% (got ${pctSum}%).`);
    }
  }
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
// range; excess is redistributed proportionally across the rest of the blend. This also structurally
// prevents a single-product 100% share whenever 2+ products are present (Fix 4).
const SWEET_HEAVY_MAX_PERCENT = 35;
const SWEET_HEAVY_ROLES = new Set(["Sweetness", "Musk/wood base", "Longevity support"]);
const HEAVY_ROLES = new Set(["Musk/wood base", "Longevity support"]);
const LIGHT_ROLES = new Set(["Freshness", "Main fruit body"]);

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

// Fix 3 — a coarse, customer-safe strength label derived from real role/ratio composition (never
// a source product name). Heavy roles (Musk/wood base, Longevity support) carrying a large share
// of the blend read as "strong"; a blend dominated by Freshness/Main fruit body with no heavy
// share reads as "light"; anything in between is "moderate."
function computeCustomerFacingStrength(roledProducts, recommendedRatio) {
  const ratioByTitle = new Map(recommendedRatio.map((r) => [r.productTitle, r.ratioPercent]));
  let heavyShare = 0;
  let lightShare = 0;
  for (const p of roledProducts) {
    const pct = ratioByTitle.get(p.title) || 0;
    if (HEAVY_ROLES.has(p.role)) heavyShare += pct;
    else if (LIGHT_ROLES.has(p.role)) lightShare += pct;
  }
  if (heavyShare >= 30) return "strong";
  if (heavyShare === 0 && lightShare >= 50) return "light";
  return "moderate";
}

// Fix 9 — the exact tier of REAL evidence backing a recommendation, so downstream wording can
// never claim more than what's actually there. Deliberately never selects a region tier
// (city/state/country) unless the customer's location has actually been verified (Fix 8) — a
// numeric sameCountryOrders count existing is not enough on its own if the location itself might
// be fictional or unconfirmed.
export function computeEvidenceScope(anchor, profile) {
  const locationVerified = Boolean(profile?.locationVerified);
  if (locationVerified && anchor.sameCityOrders > 0) return "city";
  if (locationVerified && anchor.sameStateOrders > 0) return "state";
  if (locationVerified && anchor.sameCountryOrders > 0) return "country";
  if (anchor.sameSeasonOrders > 0) return "season_global";
  if (anchor.distinctSimilarCustomers > 0 || anchor.repeatPurchaseCustomers > 0) return "global";
  return "limited";
}

const EVIDENCE_SCOPE_WEATHER_TEMPLATES = {
  city: (season) => `This direction has performed well among customers in your region during ${season || "this"} season.`,
  state: (season) => `This direction has performed well among customers in your region during ${season || "this"} season.`,
  country: (season) => `This direction has performed well among customers in your region during ${season || "this"} season.`,
  season_global: (season) => `This direction has shown wider interest during similar ${season || ""} seasonal conditions.`.replace("  ", " "),
  global: () => "This direction has shown broader interest among customers with similar preferences.",
  limited: () => "Historical evidence is limited, so this recommendation relies more heavily on compatibility and your stated preferences.",
};

function describeWeatherSuitability(evidenceScope, profile) {
  // `profile.season` here is the ephemeral, query-purposes-only value the tool layer computes
  // (requestedSeasonStyle, else a real-weather-derived label, else the calendar) — safe to use for
  // this evidence-scope wording since it's phrased generically ("during Summer season"), never as
  // a claim about what the customer said.
  const season = profile?.season;
  const base = (EVIDENCE_SCOPE_WEATHER_TEMPLATES[evidenceScope] || EVIDENCE_SCOPE_WEATHER_TEMPLATES.limited)(season);
  const hadConflict = hasSeasonWeatherConflict(profile?.requestedSeasonStyle, profile?.weatherDirection);
  if (!profile?.requestedSeasonStyle && profile?.currentWeather?.condition) {
    // No requested style at all — the default, automatic case: shaped by real conditions, no
    // mention of "season" as a customer-facing concept.
    return `${base} Shaped around today's real conditions (${profile.currentWeather.condition}).`;
  }
  if (hadConflict && profile?.seasonStyleConflictResolved && profile?.requestedSeasonStyle) {
    return `${base} Built around the classic ${profile.requestedSeasonStyle} character you asked for, even on an unusually different-feeling day.`;
  }
  return base;
}

// Fix 3 — plain, product-name-free translations of the internal risk strings (which may name real
// notes but never a source product) into a single customer-facing caution sentence.
function describeCustomerFacingRisk(risks) {
  if (!risks || !risks.length) return null;
  const risk = risks[0];
  if (risk.includes("summer heat")) return "This blend leans rich and could feel heavy in warm weather.";
  if (risk.includes("heavy oud/leather/smoke/tobacco/resin")) return "This blend is bold and long-lasting — it may feel strong for light, everyday wear.";
  if (risk.includes("fruity products may compete")) return "A few bright, fruity impressions are layered together, so the character may shift as it wears.";
  if (risk.includes("spicy products may clash")) return "This blend carries noticeable spice, which may read as bolder than a subtle everyday scent.";
  if (risk.includes("citrus alongside dense smoky")) return "This blend pairs a bright opening with a deeper base, which can feel like two phases as it wears.";
  if (risk.includes("Four products in one blend")) return "This is a more complex, layered blend, with a small risk of feeling less unified than a simpler one.";
  if (risk.includes("no contrasting role")) return "Every part of this blend leans the same direction, so it may feel one-note rather than layered.";
  return "This recommendation carries a minor fit consideration worth knowing about.";
}

// Fix 3 — a deterministic, always-available creative name (no LLM round trip required). The model
// may still offer its own more contextual name in conversation text, but the structured field the
// frontend/SSE payload relies on is never empty and never invents a factual claim.
const NAME_NOUNS = ["Edition", "Signature", "Reserve", "Essence", "Element", "Momentum", "Aura", "Motion", "Story", "Statement"];
function generateCustomerFacingName(primaryDirection, seed) {
  const [word] = pickWords(DIRECTION_VOCABULARY[primaryDirection], 1, seed + "name");
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const noun = NAME_NOUNS[hash % NAME_NOUNS.length];
  const capitalized = word.charAt(0).toUpperCase() + word.slice(1);
  return `${capitalized} ${noun}`;
}

// Fix 3 — best-use guidance grounded only in what the customer actually said (occasion) plus the
// combination's own real direction — never invents an occasion they didn't mention.
function describeBestUse(profile, primaryDirection) {
  const occasion = (profile?.occasion || "").trim();
  const byDirection = {
    light_energetic: "daytime wear, active days, and warmer settings",
    smooth_professional: "daily work, daytime and indoor professional settings",
    sweet_comforting: "casual, relaxed occasions and cooler weather",
    deep_evening: "evenings, formal occasions, and cooler weather",
  };
  const settingText = byDirection[primaryDirection] || byDirection.smooth_professional;
  return occasion ? `Great for ${occasion}, and works well for ${settingText}.` : `Works well for ${settingText}.`;
}

// Fix (finished-combination-as-ingredient) — a finished Hybrid/Tribrid/Quadbrid, or an obvious
// multi-product bundle/gift-set, must never be picked as an INGREDIENT of a different new
// combination — confirmed against real production data, where "Supernova Rebirth & Supernova Noir
// Bundle" (a bundle, not an atomic fragrance) repeatedly turned up as a component across several
// "new" recommendations. The exact-componentKey check elsewhere only catches the case where the
// whole proposed SET already exists as a combination — it never stopped an individual finished
// product from being reused as one ingredient inside a different one.
const BUNDLE_KEYWORD_PATTERN = /\b(bundle|gift set|giftset|duo pack|trio pack|value pack|set of \d)\b/i;
const FINISHED_COMBINATION_COLLECTIONS = new Set(["hybrid", "tribrid", "quadbrid"]);
function isEligibleCombinationComponent(product, finishedCombinationTitles) {
  if (finishedCombinationTitles.has(product.normalizedTitle)) return false;
  if (BUNDLE_KEYWORD_PATTERN.test(product.title)) return false;
  // Fix 8 (Aniq spec) — confirmed against real data: "Azure Supernova 2.0" has
  // collection="Tribrid" in FragranceProduct but NO row in ExistingCombination at all (an
  // incomplete/never-imported component record), so the componentKey-based check above missed it
  // entirely. The product's own catalogue classification is a second, independent signal that
  // catches this case even when ExistingCombination data is incomplete.
  if (product.collection && FINISHED_COMBINATION_COLLECTIONS.has(String(product.collection).toLowerCase())) return false;
  return true;
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
function buildSupportShortlistForAnchor(anchor, allProducts, finishedCombinationTitles, preferenceIntent, hardExcludeFamilies = [], hardExcludeTerms = []) {
  const anchorFamilies = familiesOf(anchor.orderHistoryNotes);
  const anchorNotes = new Set((anchor.orderHistoryNotes || []).map((n) => String(n).toLowerCase()));

  const scored = [];
  for (const product of allProducts) {
    if (product.normalizedTitle === anchor.normalizedProductName) continue;
    if (!isEligibleCombinationComponent(product, finishedCombinationTitles)) continue;
    // Fix (Aniq spec) — a highly sensitive customer never sees an intense product enter the
    // support shortlist at all, not just at final combination scoring.
    if (!passesIntensityFilter(product.notesJson, preferenceIntent)) continue;
    // Fix (refinement "remove X" didn't actually remove X) — see hasHardExcludedFamily/
    // hasHardExcludedTerm's own comments; never even offered as a support candidate for this pass.
    if (isHardExcluded(product.notesJson, hardExcludeFamilies, hardExcludeTerms)) continue;
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

// Fix (limit history dominance) — stacking every regional-evidence axis at once (city+country+
// state+repeat+popularity) could reach +17, enough on its own to out-rank a combo with strong
// literal-note coverage purely on regional popularity. Capped at +6 — just above the single biggest
// individual axis (same-city, 5) — so real regional evidence still counts, but can never
// single-handedly dominate the ranking the way it did in the real Karachi/Apple-Strawberry-Peach
// case that motivated this fix. Never gates eligibility either way: the literal-note hard gate in
// scoreProposedCombination already rejects a zero-match combo before this is ever computed, and a
// zero-history combo is never excluded here either — this only ever caps how much history can ADD.
export const MAX_HISTORY_SCORE = 6;
export function computeHistoryScore(anchor) {
  const rawHistoryScore =
    (anchor.sameCityOrders > 0 ? SCORE_WEIGHTS.sameCity : 0) +
    (anchor.sameCountryOrders > 0 ? SCORE_WEIGHTS.sameCountry : 0) +
    (anchor.sameStateOrders > 0 ? SCORE_WEIGHTS.sameStateRegionOrClimate : 0) +
    (anchor.repeatPurchaseCustomers > 0 ? SCORE_WEIGHTS.repeatPurchaseBySimilarCustomer : 0) +
    (anchor.distinctSimilarCustomers >= 5 ? SCORE_WEIGHTS.popularAmongSimilarCustomers : 0);
  return Math.min(rawHistoryScore, MAX_HISTORY_SCORE);
}

function scoreProposedCombination({ comboProducts, type, componentKey, profile, anchor, allCombinations, notesByNormalizedTitle, vocabUsedWords, preferenceIntent, lifestyleContext }) {
  // Reject if ANY two products in the combo are near-duplicates of each other (not just of the
  // anchor) — two shortlisted supporting products can each individually pass the anchor's
  // near-duplicate check while being siblings of one another.
  for (let i = 0; i < comboProducts.length; i++) {
    for (let j = i + 1; j < comboProducts.length; j++) {
      if (noteOverlapRatio(comboProducts[i].notes, comboProducts[j].notes) > NEAR_DUPLICATE_OVERLAP_RATIO) return null;
    }
  }
  // Fix 4 — a combination can never contain the same product twice, regardless of how it was built.
  const uniqueTitleCount = new Set(comboProducts.map((p) => normalizeProductName(p.title))).size;
  if (uniqueTitleCount !== comboProducts.length) return null;

  const { season, likes = [], dislikes = [] } = profile || {};
  const likeFamilies = textToPreferenceFamilies(likes);
  const literalLikeTerms = literalNoteTermsFromLikes(likes);
  // Fix (exact-note dislike collapsed into whole-family dislike) — confirmed live: "I dislike
  // Sandalwood" used to convert straight into the whole `woody` family, so a component loaded with
  // Cedar/Vetiver/Patchouli (zero Sandalwood) could still hit "high" severity below and reject the
  // whole combination, purely for sharing a family with the one note actually named. A literal
  // named note now hard-rejects directly on ITS OWN presence (see hasHardExcludedTerm just below);
  // only a bare family/style dislike ("Woody fragrances") still feeds the broader severity check.
  const { exactNoteDislikes, explicitFamilyDislikes } = splitDislikesByExactness(dislikes);
  const dislikeFamilies = explicitFamilyDislikes;

  // A single high-severity conflicting component disqualifies the whole combination.
  let conflictPenalty = 0;
  for (const p of comboProducts) {
    if (hasHardExcludedTerm(p.notes, exactNoteDislikes)) return null;
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

  // Fix (single_family_concentration needs to know what the customer actually asked for) —
  // likeFamilies/strengthPreference/roledProducts let the risk rules distinguish "every product
  // shares a family the customer never mentioned" (duplicate_direction, a real defect) from "every
  // product shares the family the customer explicitly asked for" (single_family_concentration,
  // whose real severity depends on role diversity and whether it actually causes a problem — see
  // that rule's own comment in fragranceCompatibility.js).
  const riskContext = { season, likeFamilies, strengthPreference: preferenceIntent?.strengthPreference, roledProducts };
  const risks = assessCombinationRisks(
    comboProducts.map((p) => ({ title: p.title, notes: p.notes })),
    riskContext,
  );
  // Fix (flat risk-count penalty replaced with severity) — severity-weighted, correlation-grouped
  // version of the same risk detection above (`risks` itself is untouched, still consumed by
  // seasonalScore/balanceRiskHit/confidence-capping below exactly as before). A "critical" severity
  // (none of the current 8 rules use it, but the mechanism is real) hard-rejects the whole
  // combination outright, the same way a high-severity dislike conflict already does.
  const riskDetails = assessCombinationRiskDetails(
    comboProducts.map((p) => ({ title: p.title, notes: p.notes })),
    riskContext,
  );
  if (riskDetails.hasCritical) return null;

  let preferenceScore = 0;
  const matchedPreferenceFamilies = new Set();
  for (const p of comboProducts) {
    const matches = matchedLikes(p.notes, likeFamilies);
    matches.forEach((family) => {
      matchedPreferenceFamilies.add(family);
      preferenceScore += SCORE_WEIGHTS.matchesLike * Math.max(0.2, likeMatchStrength(p.notes, family));
    });
  }
  // Fix (tiered exact-note coverage scoring) — a stated like of "Apple, Strawberry, Peach" collapses
  // to one `fruity` family above, so a combo built from unrelated fruity notes (Pear, Blackcurrant)
  // scored identically to one containing what the customer actually named. Distinct literal notes
  // are counted ONCE across the WHOLE combo's combined notes (never summed per-component — a note
  // appearing in two components must not double-count) and scored on a diminishing tier: 1st +10,
  // 2nd +7, 3rd+ +5 each — always bigger than the flat family bonus above, never a requirement on
  // its own (a combo with zero literal matches can still win on every other axis, exactly as before;
  // see the hard gate below for when it can't).
  const comboAllNotes = comboProducts.flatMap((p) => p.notes || []);
  const totalLiteralMatches = literalNoteMatchCount(comboAllNotes, literalLikeTerms);
  // Fix (final-batch preference coverage, requirement 6) — kept as its own named value (not just
  // folded anonymously into preferenceScore) so it can be persisted and inspected per recommendation
  // alongside matchedExactNotes/missingExactNotes/riskPenalty/riskBreakdown.
  const exactNoteScore = exactNoteCoverageScore(totalLiteralMatches);
  preferenceScore += exactNoteScore;

  // Fix (preference enforcement) — a stated like used to only ever be a scoring bonus, never a
  // requirement: a customer who said "I like spicy" could still get combinations with zero spicy
  // content if other axes (history, compatibility, balance) scored well enough. Confirmed against
  // real production data — six "spicier" refinement results all anchored on Cotton Candy de Dua
  // with no spicy-tagged component anywhere, while the model's own narration still claimed "designed
  // around your preference for spicy scents." When the customer has stated real likes, at least one
  // component must actually carry one of those families, or this combination is rejected outright —
  // never silently substituted and described as matching something it doesn't.
  if (likeFamilies.length > 0 && matchedPreferenceFamilies.size === 0) return null;
  // Fix (literal note terms lost to family-level matching, round 2) — matching the broader family
  // was enough to pass the gate above even when a customer named specific real notes and the
  // combination contains literally none of them, just a same-family stand-in. Confirmed live: a
  // customer who named Apple/Strawberry/Peach got a confirmed combination containing NONE of them —
  // it won purely on stronger regional evidence, despite every genuinely fruity alternative scoring
  // far higher on preferenceScore. When the customer named actual notes (not just style words like
  // "fruity"), a combination must contain AT LEAST ONE of them — same kind of hard requirement as
  // the family-level gate above, just tightened one notch further for a customer specific enough to
  // name real notes. Never triggers for a customer who only gave style words (literalLikeTerms empty).
  if (literalLikeTerms.length > 0 && totalLiteralMatches === 0) return null;

  const seasonalScore = risks.some((r) => r.includes("summer heat")) ? 0 : SCORE_WEIGHTS.sameSeason;

  // Real per-product order-history evidence exists only for the anchor — the one product in this
  // combination that actually came from analyze_customer_product_candidates.
  const historyScore = computeHistoryScore(anchor);

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

  // Fix 9 (Aniq spec) — confirmed real bug while writing the "same-role rejection" test: the
  // duplicate_direction risk's actual message ('Every product shares the same "X" direction with
  // no contrasting role') never contains the literal words "compete"/"duplicate"/"complex", so this
  // check silently never caught it despite the rule's own id being "duplicate_direction". Every
  // product sharing one identical primary role is exactly the case Test 9 requires to zero out the
  // balance score.
  // Fix (single_family_concentration) — the regex above can't reliably catch every phrasing of the
  // new excessive_direction_stacking case (its message varies by which real problem it found), so
  // it's checked directly by id via riskDetails (already computed) instead — the advisory/low
  // single_family_concentration/insufficient_role_diversity cases deliberately do NOT zero the
  // balance score, since those represent the customer getting exactly the one direction they asked
  // for, not a real structural flaw.
  const hasExcessiveDirectionStacking = riskDetails.breakdown.some((r) => r.id === "excessive_direction_stacking");
  const balanceRiskHit = hasExcessiveDirectionStacking || risks.some((r) => /compete|duplicate|complex|no contrasting role/i.test(r));
  const balanceScore = balanceRiskHit ? 0 : 10;
  const rolesComplementary = !balanceRiskHit && roledProducts.every((p) => p.hasDetectedFamily);

  // Fix (Aniq spec, sections 2/3) — a customer's preferred STYLE (e.g. "relaxing") now scores real
  // products directly, on its OWN score line separate from historical popularity, so it can outrank
  // a historically-popular-but-mismatched product (Test 2) rather than only ever affecting
  // customer-facing copy. Symmetrically, avoidedDirections (from high sensitivity) penalize any
  // survivor of the hard pre-generation filter that still carries 1-2 (sub-hard-limit) risk notes —
  // defense in depth alongside the earlier exclusion, never the only gate.
  //
  // Counted as DISTINCT directions matched ANYWHERE in the combo, not summed per product — the same
  // lesson already learned above for compatibilityScore ("one bonus per pair, not per family
  // combination"). Confirmed as a real bug against the live Aniq profile: summing per-product let a
  // Quadbrid (4 components) rack up 4x the style-match points of a Hybrid (2 components) purely from
  // having more products to accumulate hits across — directly fighting the complexity penalty and
  // silently crowding every Hybrid out of the results entirely. Capping the reward at
  // preferredDirections.length (regardless of how many products are in the combo) removes that
  // perverse "more products = better style score" incentive.
  const preferredDirections = preferenceIntent?.preferredDirections || [];
  const avoidedDirections = preferenceIntent?.avoidedDirections || [];
  let styleMatchScore = 0;
  for (const direction of preferredDirections) {
    if (countPreferredDirectionMatches(comboAllNotes, [direction]) > 0) styleMatchScore += 3;
  }
  let avoidedDirectionPenalty = 0;
  for (const direction of avoidedDirections) {
    if (countAvoidedDirectionMatches(comboAllNotes, [direction]) > 0) avoidedDirectionPenalty -= 5;
  }

  // Fix (lifestyle scoring) — same pattern as styleMatchScore/avoidedDirectionPenalty above, but
  // keyed off the customer's occasion/lifestyle text rather than their preferredStyle. Multiple
  // simultaneous lifestyles (interpretLifestyleContext's weighted intersection) each contribute
  // proportionally — a combo matching both "gym" and "relaxation" directions scores on both,
  // weighted, rather than only whichever lifestyle happened to be detected first.
  let lifestyleMatchScore = 0;
  const lifestylePreferred = lifestyleContext?.preferredDirections || new Map();
  const lifestyleAvoided = lifestyleContext?.avoidedDirections || new Map();
  for (const [direction, weight] of lifestylePreferred) {
    if (countPreferredDirectionMatches(comboAllNotes, [direction]) > 0) lifestyleMatchScore += 3 * weight;
  }
  let lifestyleConflictPenalty = 0;
  for (const [direction, weight] of lifestyleAvoided) {
    if (countAvoidedDirectionMatches(comboAllNotes, [direction]) > 0) lifestyleConflictPenalty -= 5 * weight;
  }

  // Fix (powdery overload) — the flat risk flag (assessCombinationRisks' powdery_overload rule,
  // already folded into `risks`/the -10-per-risk penalty below) is the same regardless of who the
  // customer is. This is the EXTRA, context-sensitive penalty on top of that: a powdery-heavy blend
  // is a bigger real mismatch for a customer whose stated style/lifestyle/sensitivity points toward
  // fresh, airy, light, gym, or relaxing scents than for one with no such signal — mirrors how
  // complexityPenalty already scales by preferSimpleCombinations rather than applying one flat
  // number to everyone. Never applied at all if the customer explicitly likes powdery/iris — their
  // own stated preference always wins over this heuristic.
  const powderyProductCount = comboProducts.filter((p) => detectFamilies(p.notes, PREFERENCE_FAMILIES).includes("powdery")).length;
  let powderyContextPenalty = 0;
  if (powderyProductCount >= 2 && !likeFamilies.includes("powdery")) {
    const sensitiveOrLight =
      preferenceIntent?.sensitivityLevel === "high" ||
      preferredDirections.some((d) => ["relaxing", "airy", "clean", "watery", "light-fruity"].includes(d)) ||
      [...lifestylePreferred.keys()].some((d) => ["airy", "crisp", "watery", "citrus-forward"].includes(d));
    if (sensitiveOrLight) powderyContextPenalty = -8;
  }

  // Fix 5 (Aniq spec) — combined complexity after de-duplicating notes across every component
  // (two products sharing several notes shouldn't double-count them), penalized more heavily when
  // the customer prefers simple combinations — this is what lets a simple two-product Hybrid
  // outrank a complex Tribrid/Quadbrid built from the same candidate pool (Test 6).
  const combinedUniqueNoteCount = new Set(comboProducts.flatMap((p) => (p.notes || []).map((n) => String(n).toLowerCase()))).size;
  const combinedComplexity = computeComplexityLevel(combinedUniqueNoteCount);
  const preferSimple = Boolean(preferenceIntent?.preferSimpleCombinations);
  const COMPLEXITY_PENALTY = {
    low: 0,
    moderate: preferSimple ? -2 : -1,
    high: preferSimple ? -6 : -2,
    "very-high": preferSimple ? -12 : -4,
  };
  const complexityPenalty = COMPLEXITY_PENALTY[combinedComplexity] ?? 0;

  // Fix (Aniq spec, section 5) — a DIRECT, explicit product-count bias, separate from the combined-
  // note-complexity penalty above. Confirmed necessary against real data: a genuinely simple 3-note
  // anchor (e.g. "Herbs & Sea Salt") paired with two 9-12-note real support products still nets
  // "very-high" combined complexity and a Tribrid shape — the complexity penalty alone wasn't
  // severe enough to stop it out-scoring a genuine two-product Hybrid once history/style/
  // compatibility scores are added back in. This directly implements "prefer two-product Hybrids...
  // avoid automatically filling results with Tribrids... use Quadbrids only when specifically
  // requested or strongly justified" as its own real scoring line, not just an indirect hope.
  //
  // Fix (every single recommendation came back Quadbrid for an ordinary, non-sensitive customer) —
  // confirmed live: this bias used to be entirely OFF (all zeros) unless preferSimple was true, which
  // only ever happens for a customer with an explicit sensitivity signal (SENSITIVITY_PHRASES). The
  // spec line above says "use Quadbrids only when specifically requested or strongly justified" for
  // EVERY customer, not just sensitive ones — with the bias fully zeroed by default, a Quadbrid's
  // sheer product-count advantage on every OTHER additive score (more components = more chances to
  // rack up preference/history/compatibility points) went completely unopposed, so it mechanically
  // won every single time regardless of whether it genuinely fit better. Reusing the same magnitude
  // already used for the sensitive case as the real default now, with sensitivity layering on an
  // even stronger penalty on top — not zero, since "strongly justified" was never meant to mean
  // "no justification needed at all" for the common, non-sensitive customer.
  const TYPE_SIMPLICITY_SCORE = preferSimple
    ? { HYBRID: 14, TRIBRID: -10, QUADBRID: -22 }
    : { HYBRID: 10, TRIBRID: -6, QUADBRID: -16 };
  const typeSimplicityScore = TYPE_SIMPLICITY_SCORE[type] ?? 0;

  // Fix (flat risk-count penalty replaced with severity) — every identified risk used to cost a
  // flat -10 regardless of how minor ("four products" advisory) or serious ("zero contrast at all")
  // it actually was, and a Tribrid/Quadbrid mechanically racks up more hits than a Hybrid just from
  // having more components to flag, unrelated to real fit. riskDetails.riskPenalty is the
  // severity-weighted, correlation-deduplicated total computed above (advisory -1 … high -10; a
  // "critical" hit already hard-rejected the combination before this line is ever reached).
  const finalScore =
    preferenceScore + seasonalScore + historyScore + compatibilityScore + analogousScore + balanceScore + conflictPenalty +
    styleMatchScore + avoidedDirectionPenalty + complexityPenalty + typeSimplicityScore +
    lifestyleMatchScore + lifestyleConflictPenalty + powderyContextPenalty + riskDetails.riskPenalty;

  // Fix 10 — deterministic confidence with hard caps layered on top of the numeric threshold, so a
  // risk-laden or evidence-thin combination can never read as "very high"/"high" just by
  // accumulating enough small positive signals elsewhere.
  const evidenceScope = computeEvidenceScope(anchor, profile);
  const profileComplete =
    Boolean(profile?.locationVerified) &&
    Array.isArray(profile?.dislikes) &&
    profile.dislikes.length >= 0 && // dislikes may be an empty array, but must have been asked about
    Object.prototype.hasOwnProperty.call(profile || {}, "dislikes") &&
    (profile?.likes?.length > 0 || Boolean(profile?.preferredStyle));
  const seasonUnresolved =
    hasSeasonWeatherConflict(profile?.requestedSeasonStyle, profile?.weatherDirection) && profile?.seasonStyleConflictResolved === false;

  let confidence;
  if (finalScore >= 30 && risks.length === 0) confidence = "very high";
  else if (finalScore >= 20 && risks.length <= 1) confidence = "high";
  else if (finalScore >= 10 && risks.length <= 2) confidence = "medium";
  else confidence = "low";

  const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2, "very high": 3 };
  const cap = (label) => {
    if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[label]) confidence = label;
  };
  if (historyScore === 0) cap("medium");
  if (!profile?.locationVerified) cap("medium");
  if (!rolesComplementary) cap("medium");
  if (seasonUnresolved) cap("medium");
  if (risks.length > 0) cap("high");
  if (!profileComplete) cap("high");
  if (evidenceScope === "limited" || evidenceScope === "global") cap("medium");
  // Fix (confidence's own hard-cap-to-"low" rule used a raw risk COUNT, the exact flat-count
  // anti-pattern the rest of this codebase already moved away from for risk scoring itself) —
  // confirmed as a real, newly-consequential bug once confidence started gating auto-confirmation
  // (Phase 15): two merely "advisory" risks (e.g. competing_fruits + quadbrid_complexity, -1 each)
  // forced "low" exactly as hard as two "high" ones would, blocking a perfectly reasonable
  // recommendation from ever auto-confirming. riskDetails.riskPenalty is the SAME severity-weighted,
  // correlation-deduplicated total already used in finalScore — reusing it here instead of the raw
  // count means only a genuinely serious risk load (roughly one high-severity hit, or several real
  // medium ones) caps this low, not a couple of minor nitpicks.
  if (riskDetails.riskPenalty <= -10) cap("low");
  // Fix (Aniq spec) — a highly sensitive/simple-preference customer can never read a very-high- or
  // high-complexity combination as more confident than the complexity genuinely supports.
  if (preferSimple && combinedComplexity === "very-high") cap("low");
  else if (preferSimple && combinedComplexity === "high") cap("medium");

  // Fix (multidimensional confidence) — the single blended `confidence` above stays exactly as-is
  // for existing consumers, but it can hide exactly the kind of mismatch this was built to surface:
  // a combination can be technically compatible and genuinely novel while fitting this SPECIFIC
  // customer poorly, or vice versa. Every dimension below is a deterministic banding of a score
  // this function already computed — no new scoring machinery, just naming what's already there.
  const HISTORICAL_CONFIDENCE_BY_SCOPE = { city: "high", state: "high", country: "medium", season_global: "medium", global: "low", limited: "low" };
  const historicalConfidence = HISTORICAL_CONFIDENCE_BY_SCOPE[evidenceScope] || "low";

  const minNoteCount = Math.min(...comboProducts.map((p) => (p.notes || []).length));
  const dataConfidence = minNoteCount >= 3 ? "high" : minNoteCount >= 1 ? "medium" : "low";

  // Fix (compatibility confidence used a raw risk COUNT) — the same flat-count anti-pattern
  // finalScore's own risk penalty and the "low" confidence cap were already fixed to avoid:
  // two or more merely-advisory/low-severity risks (e.g. a spice_conflict plus a mild
  // excessive_direction_stacking) read as "low" compatibility exactly as hard as an actual
  // high-severity risk would, even though nothing about the combination is genuinely
  // incompatible. Reuses the same severity-weighted riskPenalty everything else already does.
  const compatibilityConfidence =
    riskDetails.riskPenalty === 0 && rolesComplementary ? "high" : riskDetails.riskPenalty > -10 ? "medium" : "low";

  const noveltyConfidence = analogousExistingCombinations.length >= 2 ? "high" : analogousExistingCombinations.length >= 1 ? "medium" : "low";

  const customerFitRaw = preferenceScore + styleMatchScore + lifestyleMatchScore;
  const customerFitConfidence = !profileComplete ? "low" : customerFitRaw >= 8 ? "high" : customerFitRaw >= 3 ? "medium" : "low";

  const confidenceBreakdown = {
    data: { value: dataConfidence, reason: dataConfidence === "high" ? "Every component has a full, real note list on file." : "At least one component's real note list is thin." },
    historical: { value: historicalConfidence, reason: `Evidence scope: ${evidenceScope}.` },
    compatibility: { value: compatibilityConfidence, reason: risks.length ? `${risks.length} real compatibility risk(s) identified.` : "No compatibility risks identified; roles are complementary." },
    novelty: { value: noveltyConfidence, reason: analogousExistingCombinations.length ? `${analogousExistingCombinations.length} analogous existing combination(s) share real notes with this one.` : "No closely analogous existing combination found." },
    customerFit: { value: customerFitConfidence, reason: !profileComplete ? "Profile is missing required signal (location/likes/style)." : `Preference/style/lifestyle match score: ${customerFitRaw}.` },
    // Fix (remove the always-low performance dimension) — this used to always read "low," on every
    // single recommendation, since no real longevity/projection/sillage data exists anywhere in the
    // source data — it never carried any real signal, never capped the overall confidence (it was
    // display-only), and only ever made every result look worse than the other five dimensions
    // actually supported. Removed rather than kept as permanent dead weight.
  };
  // Fix (multidimensional confidence) — customer-fit and data quality are the two dimensions most
  // likely to silently diverge from a healthy-looking blended score (a combination can be
  // compatible, novel, and well-evidenced while still fitting THIS customer poorly, or be built on
  // thin note data) — both explicitly cap the overall field the same way every other hard cap above
  // does, rather than staying siloed inside confidenceBreakdown where nothing else reads them.
  if (dataConfidence === "low") cap("low");
  if (customerFitConfidence === "low") cap("medium");

  const roledForRatio = roledProducts;
  const recommendedRatio = computeRatios(roledForRatio);

  // Fix 3 — customer-facing derived fields, all generated from real, already-computed data; none
  // of them ever contains a source product title.
  const primaryDirection = directionForRole(roledProducts[0]?.role || "Contrast");
  const customerFacingDescription = describeCharacter(roledProducts.map((p) => p.role), componentKey, vocabUsedWords);
  const customerFacingBestUse = describeBestUse(profile, primaryDirection);
  const customerFacingWeatherSuitability = describeWeatherSuitability(evidenceScope, profile);
  const customerFacingStrength = computeCustomerFacingStrength(roledProducts, recommendedRatio);
  const customerFacingRisk = describeCustomerFacingRisk(risks);

  // Fix 13 (Aniq spec) — the generated name must reflect the REAL overall intensity across every
  // component, computed AFTER the full profile is known — not just the anchor's own individual
  // role. Without this, a genuinely heavy/complex formula (several real intensity-driving notes,
  // very-high combined complexity, or a "strong" overall strength reading) could still get named
  // from the light/calm vocabulary pool purely because its first product happened to read as
  // "Freshness" — concealing a heavy formula behind words like "calm"/"soft"/"effortless".
  const totalIntensityDrivers = roledProducts.reduce((sum, p) => sum + (p.intensityDrivers?.length || 0), 0);
  const isOverallIntense = totalIntensityDrivers >= 3 || combinedComplexity === "very-high" || customerFacingStrength === "strong";
  const namingDirection = isOverallIntense ? "deep_evening" : primaryDirection;
  const customerFacingName = generateCustomerFacingName(namingDirection, componentKey);
  const customerFacingWhySuits = matchedPreferenceFamilies.size
    ? `Designed around your preference for ${[...matchedPreferenceFamilies].join(" and ")} scents.`
    : "Designed to be a versatile, easy-to-wear everyday option.";

  const internalProducts = roledProducts.map((p) => ({ title: p.title, notes: p.notes, fragranceFamily: null, contribution: p.role }));

  // Fix (Aniq spec, sections 11-12) — REAL product names and notes are now customer-facing (this
  // reverses the earlier "Product 1/2/3" generic-label design, per this spec's own explicit,
  // repeated instruction: "Do not limit the response to generic labels such as 'Product 1'... Do
  // not hide the real product names in the recommendation response"). `internalProducts` above
  // remains the backend/Shopify-creation source of truth; these are the same real names/notes,
  // just organized into the shape the frontend and model narration actually consume.
  const customerFacingNotesByProduct = internalProducts.map((p) => ({
    label: p.title,
    notes: (p.notes || []).slice(0, 5),
  }));
  const components = internalProducts.map((p) => {
    const ratio = recommendedRatio.find((r) => r.productTitle === p.title);
    return {
      productName: p.title,
      availableNotes: (p.notes || []).slice(0, 5),
      contribution: p.contribution,
      ratioPercent: ratio ? ratio.ratioPercent : null,
    };
  });
  // Real notes present in EVERY component's note list — not invented, computed directly from the
  // same notesJson used everywhere else.
  const sharedOrConnectingNotes = internalProducts.length < 2 ? [] : (() => {
    const noteSets = internalProducts.map((p) => new Set((p.notes || []).map((n) => String(n).toLowerCase())));
    const sharedLower = [...noteSets[0]].filter((n) => noteSets.slice(1).every((s) => s.has(n)));
    return (internalProducts[0].notes || []).filter((n) => sharedLower.includes(String(n).toLowerCase()));
  })();
  const whyNotesWork = compatibilityReasons.length
    ? compatibilityReasons.slice(0, 3).join(" ")
    : "Each component plays a distinct, real role in the blend rather than repeating the same direction.";
  const expectedResult = `A ${customerFacingDescription} result, built from ${internalProducts.map((p) => p.title).join(" and ")}.`;

  validateCombinationShape({ type, products: internalProducts, recommendedRatio });

  return {
    // Internal — never sent to the frontend, SSE customer payloads, or the model's customer-facing
    // narration (see fragranceAgentTools.server.js's stripInternalFields).
    internalProducts,
    canonicalKey: componentKey,
    compatibilityReasons,
    historicalEvidence: {
      sameCityOrders: anchor.sameCityOrders,
      sameStateOrders: anchor.sameStateOrders,
      sameCountryOrders: anchor.sameCountryOrders,
      sameSeasonOrders: anchor.sameSeasonOrders,
      distinctSimilarCustomers: anchor.distinctSimilarCustomers,
      repeatPurchaseCustomers: anchor.repeatPurchaseCustomers,
    },
    // Fix 11/12 (Aniq spec) — the same real counts as historicalEvidence above, translated into
    // plain sentences safe to show the customer directly; never claims evidence that isn't real
    // (a zero count reads as "not available," never omitted or silently inflated). Fix 16: labeled
    // as historical data, explicitly not a claim of current popularity.
    customerFacingHistoricalEvidence: {
      cityEvidence: anchor.sameCityOrders > 0 ? `${anchor.sameCityOrders} historical order(s) from the same city.` : "No same-city order history available.",
      countryEvidence: anchor.sameCountryOrders > 0 ? `${anchor.sameCountryOrders} historical order(s) from the same country.` : "No same-country order history available.",
      seasonalEvidence: anchor.sameSeasonOrders > 0 ? `${anchor.sameSeasonOrders} historical order(s) during the same season.` : "No same-season order history available.",
      repeatEvidence: anchor.repeatPurchaseCustomers > 0 ? `${anchor.repeatPurchaseCustomers} similar customer(s) repeat-purchased this direction.` : "No repeat-purchase evidence available.",
      dataWindow: "Reflects real historical order data through October 2024 — not a claim of current popularity.",
    },
    existingCombinationEvidence: {
      exactCombinationExists: false, // structurally guaranteed — see the componentKey exclusion above
      similarEvidence: analogousExistingCombinations,
    },
    components,
    combinedDirection: customerFacingDescription,
    sharedOrConnectingNotes,
    whyNotesWork,
    expectedResult,
    analogousExistingCombinations,
    preferenceScore,
    seasonalScore,
    historyScore,
    compatibilityScore,
    balanceScore,
    conflictPenalty,
    styleMatchScore,
    avoidedDirectionPenalty,
    complexityPenalty,
    typeSimplicityScore,
    lifestyleMatchScore,
    lifestyleConflictPenalty,
    powderyContextPenalty,
    matchedLifestyles: lifestyleContext?.lifestyles || [],
    combinedComplexity,
    finalScore,
    recommendedRatio,
    risks,
    // Fix (flat risk-count penalty replaced with severity) — persisted so a confirmed recommendation
    // still shows exactly how its risk penalty was computed, not just the blended finalScore.
    riskPenalty: riskDetails.riskPenalty,
    riskBreakdown: riskDetails.breakdown,
    // Fix (final-batch preference coverage, requirement 6) — the raw tiered-coverage contribution,
    // separate from the blended preferenceScore it was added into.
    exactNoteCoverageScore: exactNoteScore,

    // Customer-facing — safe for SSE payloads, recommendation cards, and chat text.
    type,
    existsAlready: false,
    evidenceScope,
    confidence,
    // Fix (multidimensional confidence) — additive only; existing consumers reading `confidence`
    // directly are unaffected. `confidence` itself is still the single overall field, now capped by
    // customerFit/data confidence in addition to its existing hard caps.
    confidenceBreakdown,
    customerFacingName,
    customerFacingDescription,
    customerFacingWhySuits,
    customerFacingBestUse,
    customerFacingWeatherSuitability,
    customerFacingStrength,
    customerFacingRisk,
    customerFacingNotesByProduct,
  };
}

// Every valid, newly-scored proposal buildable from ONE anchor — extracted out of
// generateNewProductCombinations' main loop so the exact same logic can also run for the
// fallback anchors the final-batch coverage check below seeds when a customer's named note is
// completely absent from the normal pass, instead of duplicating the anchor/type/support-combo
// triple loop a second time.
function generateCombosForAnchor(anchor, ctx) {
  const { allProducts, finishedCombinationTitles, preferenceIntent, allowedTypes, profile, allCombinations, notesByNormalizedTitle, lifestyleContext, vocabUsedWords, existingComponentKeys, seenComponentKeys, hardExcludeFamilies, hardExcludeTerms } = ctx;
  const proposals = [];
  const shortlist = buildSupportShortlistForAnchor(anchor, allProducts, finishedCombinationTitles, preferenceIntent, hardExcludeFamilies, hardExcludeTerms);
  if (!shortlist.length) return proposals;

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
        lifestyleContext,
        vocabUsedWords,
        preferenceIntent,
      });
      if (proposal) proposals.push(proposal);
    }
  }
  return proposals;
}

// Fix (final-batch preference coverage) — the per-combination literal-note gate only ever required
// ONE named note per combo, so a whole batch could still leave a note like "Strawberry" completely
// uncovered even though every individual combo satisfies its own requirement. For each such missing
// term, finds real catalog products that literally contain it (reusing real regional evidence from
// candidateProducts when the same product is already there, otherwise a zero-evidence pseudo-anchor
// — "preserve zero-history catalog products when they strongly match explicit customer notes").
// Bounded to a small number of real products per missing term; this is a targeted top-up, not a
// full catalog re-scan.
const FALLBACK_ANCHORS_PER_MISSING_TERM = 3;
export function buildFallbackAnchorsForMissingTerms(missingTerms, { allProducts, finishedCombinationTitles, preferenceIntent, candidateProducts, hardExcludeFamilies = [], hardExcludeTerms = [] }) {
  const byNormalizedTitle = new Map((candidateProducts || []).map((c) => [c.normalizedProductName, c]));
  const seen = new Set();
  const anchors = [];
  for (const term of missingTerms) {
    let added = 0;
    for (const product of allProducts) {
      if (added >= FALLBACK_ANCHORS_PER_MISSING_TERM) break;
      if (seen.has(product.normalizedTitle)) continue;
      if (!isEligibleCombinationComponent(product, finishedCombinationTitles)) continue;
      if (!passesIntensityFilter(product.notesJson, preferenceIntent)) continue;
      if (isHardExcluded(product.notesJson, hardExcludeFamilies, hardExcludeTerms)) continue;
      if (matchedLiteralTerms(product.notesJson, [term]).length === 0) continue;

      seen.add(product.normalizedTitle);
      added++;
      const existing = byNormalizedTitle.get(product.normalizedTitle);
      anchors.push(
        existing || {
          productName: product.title,
          normalizedProductName: product.normalizedTitle,
          collection: product.collection,
          orderHistoryNotes: product.notesJson || [],
          sameCityOrders: 0, sameStateOrders: 0, sameCountryOrders: 0, sameSeasonOrders: 0,
          distinctSimilarCustomers: 0, repeatPurchaseCustomers: 0,
        },
      );
    }
  }
  return anchors;
}

/**
 * @param {object} args
 * @param {object} args.profile - CustomerFragranceProfile-shaped (season, likes, dislikes used here).
 * @param {Array} args.candidateProducts - ProductCandidate[] from analyzeCustomerProductCandidates.
 * @param {number} [args.maximumResults]
 * @param {string[]} [args.allowedTypes] - subset of ["HYBRID","TRIBRID","QUADBRID"].
 * @param {string[]} [args.hardExcludeFamilies] - PREFERENCE_FAMILIES keys to hard-exclude from every
 *   anchor and support candidate this call — for a refinement's own freshly-named "remove X" request
 *   only (see hasHardExcludedFamily's comment), never the customer's general stated dislikes, which
 *   keep the existing softer per-component severity treatment.
 * @param {string[]} [args.hardExcludeTerms] - literal note names to hard-exclude by directly, the
 *   same way, for a name with no PREFERENCE_FAMILIES entry at all (see hasHardExcludedTerm's comment).
 */
export async function generateNewProductCombinations({ profile, candidateProducts, maximumResults = DEFAULT_MAX_RESULTS, allowedTypes = ALL_TYPES, hardExcludeFamilies = [], hardExcludeTerms = [] }) {
  const { allProducts, allCombinations } = await getCatalogAndCombinations();
  const notesByNormalizedTitle = new Map(allProducts.map((p) => [p.normalizedTitle, p.notesJson || []]));
  // Loaded once, checked in-memory per candidate combo below — avoids one DB round trip per
  // candidate (with up to ~450 candidate combos generated per request, that was the dominant cost
  // in testing before this fix).
  const existingComponentKeys = new Set(allCombinations.map((c) => c.componentKey));
  // Fix (finished-combination-as-ingredient) — a product that IS itself a finished Hybrid/Tribrid/
  // Quadbrid must never become an anchor OR a support ingredient of a DIFFERENT new combination.
  const finishedCombinationTitles = new Set(allCombinations.map((c) => c.normalizedTitle));
  // Fix (Aniq spec) — computed ONCE per generation call; drives hard pre-generation filters
  // (anchor/support eligibility below) as well as complexity-aware scoring/type bias downstream.
  const preferenceIntent = interpretCustomerPreferences(profile);
  // Fix (lifestyle scoring) — computed ONCE per generation call, same as preferenceIntent.
  const lifestyleContext = interpretLifestyleContext(profile);

  const anchors = (candidateProducts || [])
    .filter((c) =>
      isEligibleCombinationComponent({ title: c.productName, normalizedTitle: c.normalizedProductName, collection: c.collection }, finishedCombinationTitles) &&
      passesIntensityFilter(c.orderHistoryNotes, preferenceIntent) &&
      !isHardExcluded(c.orderHistoryNotes, hardExcludeFamilies, hardExcludeTerms),
    )
    .slice()
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, MAX_ANCHORS);
  if (!anchors.length) return [];

  const results = [];
  const seenComponentKeys = new Set();
  // Threaded across the WHOLE batch (Fix 2) so no two cards in the same result set repeat the
  // same adjective — reset per generateNewProductCombinations call, not global.
  const vocabUsedWords = new Set();
  const genCtx = {
    allProducts, finishedCombinationTitles, preferenceIntent, allowedTypes, profile,
    allCombinations, notesByNormalizedTitle, lifestyleContext, vocabUsedWords,
    existingComponentKeys, seenComponentKeys, hardExcludeFamilies, hardExcludeTerms,
  };

  for (const anchor of anchors) {
    results.push(...generateCombosForAnchor(anchor, genCtx));
  }

  results.sort((a, b) => b.finalScore - a.finalScore);
  let finalResults = selectDiverseResults(results, maximumResults);

  // Fix (final-batch preference coverage) — an individual combo only ever had to contain ONE of the
  // customer's literally named notes (see scoreProposedCombination's hard gate), so the batch as a
  // whole could still leave a note like "Strawberry" completely uncovered even though every combo
  // individually satisfies its own requirement. Confirmed live: exactly this pattern, just one level
  // up from the per-combo bug already fixed. When that happens, seed a small, targeted set of real
  // catalog products that literally contain the missing note as EXTRA anchors and regenerate — never
  // a full re-scan, and never required to succeed (a note nothing eligible actually contains stays
  // honestly reported as missing, not silently dropped).
  const literalLikeTerms = literalNoteTermsFromLikes(profile?.likes || []);
  // Fix (final-batch coverage metadata incomplete) — matchedExactNotes/missingExactNotes were
  // already persisted, but nothing recorded WHAT was originally requested (as its own field, not
  // just matched-union-missing) or WHETHER/WHAT a fallback regeneration pass actually targeted —
  // so admin/debug metadata could never distinguish "never needed a fallback" from "a fallback ran
  // and these specific terms were the target," which the spec calls for explicitly.
  let fallbackUsed = false;
  let fallbackTargetNotes = [];
  if (literalLikeTerms.length > 0) {
    const batchNotes = finalResults.flatMap((r) => r.internalProducts.flatMap((p) => p.notes || []));
    const missing = missingLiteralTerms(batchNotes, literalLikeTerms);
    if (missing.length) {
      fallbackUsed = true;
      fallbackTargetNotes = missing;
      const fallbackAnchors = buildFallbackAnchorsForMissingTerms(missing, { allProducts, finishedCombinationTitles, preferenceIntent, candidateProducts, hardExcludeFamilies, hardExcludeTerms });
      for (const anchor of fallbackAnchors) {
        results.push(...generateCombosForAnchor(anchor, genCtx));
      }
      results.sort((a, b) => b.finalScore - a.finalScore);
      finalResults = selectDiverseResults(results, maximumResults);
    }
  }

  // Fix (final-batch preference coverage) — every returned recommendation now carries exactly which
  // of the customer's literally named notes IT covers and which it doesn't, regardless of whether
  // the regeneration pass above found anything — internal/debug metadata only (see
  // recommendationConfirmation.server.js's scoreJson persistence and toCustomerSafeRecommendation's
  // explicit allow-list, which never exposes this). Recomputed AFTER the fallback rerank above (not
  // assumed from the fallback attempt alone), so a term that still isn't in the true final batch is
  // honestly reported as missing rather than assumed covered just because a fallback pass ran.
  for (const r of finalResults) {
    const notes = r.internalProducts.flatMap((p) => p.notes || []);
    r.requestedExactNotes = literalLikeTerms;
    r.matchedExactNotes = matchedLiteralTerms(notes, literalLikeTerms);
    r.missingExactNotes = missingLiteralTerms(notes, literalLikeTerms);
    r.fallbackUsed = fallbackUsed;
    r.fallbackTargetNotes = fallbackTargetNotes;
  }

  // Fix (vagueness diagnosis) — only the proposals actually being returned pay for a real,
  // note-aware copy-generation call; every other scored-but-discarded candidate (up to ~450 per
  // request) never does. On any failure this leaves customerFacingDescription/customerFacingWhySuits
  // exactly as scoreProposedCombination() already set them above (the deterministic fallback).
  const catalogTitlesLowercase = allProducts.map((p) => p.title.toLowerCase()).filter((t) => t.length >= 4);
  const copyItems = finalResults.map((proposal) => {
    const notesByRole = {};
    for (const p of proposal.internalProducts) {
      const existing = notesByRole[p.contribution] || [];
      notesByRole[p.contribution] = [...new Set([...existing, ...p.notes])];
    }
    return { proposal, notesByRole };
  });
  await applyCustomerFacingCopy(
    copyItems,
    { likes: profile?.likes, dislikes: profile?.dislikes, preferredStyle: profile?.preferredStyle, occasion: profile?.occasion },
    catalogTitlesLowercase,
  );

  return finalResults;
}
