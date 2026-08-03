import { PREFERENCE_FAMILIES, detectFamilies } from "./fragranceCompatibility.js";

// Phase 3 "base scoring rules" — verbatim point values from the product spec. Kept as named
// constants (not inlined) so orderHistoryAnalysis.server.js's SQL/aggregation-driven scoring and
// any future scoring code stay in sync with a single source of truth.
export const SCORE_WEIGHTS = {
  sameCity: 5,
  sameCountry: 4,
  sameStateRegionOrClimate: 3,
  sameSeason: 4,
  matchesLike: 5,
  conflictsDislike: -10,
  repeatPurchaseBySimilarCustomer: 3,
  popularAmongSimilarCustomers: 2,
};

// Spec: "A dislike conflict should be recorded when the product has a prominent conflicting note
// or family. Do not automatically reject a product for one minor supporting note unless the
// conflict is substantial." No exact algorithm is specified beyond the four severity labels, so
// this is a deterministic heuristic: severity scales with how MANY of the product's notes hit a
// disliked family, and whether a hit falls among the first few notes (treated as more prominent,
// since notesJson preserves the source spreadsheet's note order).
const PROMINENT_NOTE_WINDOW = 3;

export function classifyDislikeConflict(productNotes, dislikeFamilies) {
  const notes = Array.isArray(productNotes) ? productNotes : [];
  if (!notes.length || !dislikeFamilies?.length) {
    return { severity: "none", matchedFamilies: [], matchedNoteCount: 0 };
  }

  const matchedFamilies = dislikeFamilies.filter((family) => {
    const keywords = PREFERENCE_FAMILIES[family];
    return keywords && detectFamilies(notes, { [family]: keywords }).length > 0;
  });

  if (!matchedFamilies.length) {
    return { severity: "none", matchedFamilies: [], matchedNoteCount: 0 };
  }

  const lowerNotes = notes.map((n) => String(n).toLowerCase());
  let matchedNoteCount = 0;
  let matchedInProminentWindow = false;
  for (const family of matchedFamilies) {
    const keywords = PREFERENCE_FAMILIES[family];
    lowerNotes.forEach((note, index) => {
      if (keywords.some((kw) => note.includes(kw))) {
        matchedNoteCount++;
        if (index < PROMINENT_NOTE_WINDOW) matchedInProminentWindow = true;
      }
    });
  }

  const matchRatio = matchedNoteCount / notes.length;
  let severity;
  if (matchedNoteCount >= 3 || matchRatio >= 0.4) {
    severity = "high";
  } else if (matchedNoteCount === 2 || (matchedNoteCount === 1 && matchedInProminentWindow)) {
    severity = "medium";
  } else {
    severity = "low";
  }

  return { severity, matchedFamilies, matchedNoteCount };
}

// Spec: preference-family matching for likes ("Matches customer like: +5"). Returns the subset of
// `likes` (customer-stated free-text preferences) whose mapped family is present in the product's
// real notes.
export function matchedLikes(productNotes, likeFamilies) {
  return likeFamilies.filter((family) => {
    const keywords = PREFERENCE_FAMILIES[family];
    return keywords && detectFamilies(productNotes, { [family]: keywords }).length > 0;
  });
}

// Fix (preference score ignored HOW MUCH of a product is the liked family) — matchedLikes above
// only ever checks whether a family matches AT LEAST ONE note, so a product with a single
// incidental "Vanilla" note among 18 completely different notes earned the exact same bonus as one
// genuinely built around sweetness — confirmed live. Returns what FRACTION of a product's real
// notes actually fall in the given family, so a caller can scale a bonus by real relevance instead
// of a flat presence check. Shared by recommendationEngine.server.js's preferenceScore weighting
// and orderHistoryAnalysis.server.js's like-matched candidate gathering — both need the same
// "how much, not just whether" measure.
export function likeMatchStrength(notes, family) {
  const keywords = PREFERENCE_FAMILIES[family];
  if (!keywords || !notes?.length) return 0;
  const matchingCount = notes.filter((note) => {
    const lower = String(note).toLowerCase();
    return keywords.some((kw) => lower.includes(kw));
  }).length;
  return matchingCount / notes.length;
}

// Spec's ProductCandidate shape requires an overall "evidenceLevel": "high" | "medium" | "low".
// No exact thresholds are given, so this uses the same evidence counts the candidate already
// carries (distinct similar customers, same-season orders) rather than inventing new signals.
export function computeEvidenceLevel({ distinctSimilarCustomers = 0, sameSeasonOrders = 0 } = {}) {
  if (distinctSimilarCustomers >= 10 || sameSeasonOrders >= 25) return "high";
  if (distinctSimilarCustomers >= 3 || sameSeasonOrders >= 5) return "medium";
  return "low";
}
