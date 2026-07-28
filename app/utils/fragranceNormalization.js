// Shared normalization helpers for the fragrance recommendation engine. Product-name and
// location normalization both live here so ingestion scripts, scoring services, and chat.jsx
// all match text the same way — a customer typing "the opera" must resolve to the same real
// product as an order-history row storing "The Opera ".

// ============================================================
// Product name normalization
// ============================================================

// Lowercase, trim, collapse whitespace, drop punctuation that doesn't change identity (matching
// the same shape of normalization already used for region text below) — so "The Opera", "the
// opera!", and "THE   OPERA" all resolve to one key.
export function normalizeProductName(title) {
  if (!title) return "";
  return String(title)
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================
// Season normalization
// ============================================================

// The raw "Updated Season" column turned out to be inconsistently labeled (verified directly
// against the real DB: "Fall" and "Autumn Months" both exist as distinct values, likewise "Spring
// Months", "Winter Months", "Summer Months", alongside junk like "Not Found"/"#N/A"/"0"/null). An
// exact match on just the clean season name would silently miss the alias-labeled rows. Moved
// (not duplicated) from app/routes/chat.jsx so orderHistoryAnalysis.server.js queries the same
// season values the same way.
export const SEASON_ALIASES = {
  Winter: ["Winter", "Winter Months"],
  Spring: ["Spring", "Spring Months"],
  Summer: ["Summer", "Summer Months"],
  Fall: ["Fall", "Autumn Months"],
};

// ============================================================
// Region/location normalization
// ============================================================

// Moved verbatim from app/routes/chat.jsx (previously private to that file) so ingestion scripts
// and services can match location text identically to the live chat flow — city/state/country
// names have inconsistent punctuation in the source data (e.g. "St. Clair Shores" vs "St Clair
// Shores"), so normalizing both sides the same way means either spelling still matches.
export function normalizeRegionText(str) {
  return str.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

// A small, explicit, human-reviewed list of unambiguous location misspellings — deliberately NOT
// a fuzzy-match/edit-distance heuristic, since that can silently "correct" one real place name
// into a different real place name. Only obvious, well-known typos belong here; anything else
// must go through resolveLocationInput's ambiguous path instead of being guessed.
const KNOWN_LOCATION_CORRECTIONS = {
  "los angelos": "Los Angeles",
  "califronia": "California",
  "calfornia": "California",
  "united state": "United States",
  "unitedstates": "United States",
  "untied states": "United States",
  "newyork": "New York",
  "phillipines": "Philippines",
  "phillippines": "Philippines",
};

// Resolves a customer-typed location string against (a) the known-typo list above, then (b) real
// region names actually present in order-history data (via the same regionMaps shape
// getRegionMaps() in chat.jsx already builds — city/stateName/countryName -> Map(normalized ->
// real casing)). Returns a confident match only when one of those two sources actually agrees;
// otherwise flags it as needing confirmation rather than silently guessing — per the explicit
// requirement to never auto-correct an ambiguous location.
export function resolveLocationInput(input, regionMaps) {
  if (!input || !input.trim()) return { resolved: false, needsConfirmation: false, value: null };

  const normalized = normalizeRegionText(input);
  const knownCorrection = KNOWN_LOCATION_CORRECTIONS[normalized];

  // A known correction still only counts as confidently resolved if the corrected name is also a
  // real region in the actual data — otherwise it's "a well-known typo of somewhere we have no
  // data for," which should still surface as a real (if data-thin) location, not be discarded.
  const candidateText = knownCorrection || input;
  const candidateNormalized = normalizeRegionText(candidateText);

  for (const field of ["city", "stateName", "countryName"]) {
    const map = regionMaps?.[field];
    if (map && map.has(candidateNormalized)) {
      return {
        resolved: true,
        needsConfirmation: false,
        field,
        value: map.get(candidateNormalized),
        wasCorrected: Boolean(knownCorrection),
        originalInput: input,
      };
    }
  }

  if (knownCorrection) {
    // A known typo, but the corrected spelling isn't in our region data either — still confident
    // about the correction itself, just with no regional trend data behind it.
    return {
      resolved: true,
      needsConfirmation: false,
      field: null,
      value: knownCorrection,
      wasCorrected: true,
      originalInput: input,
    };
  }

  // Not an exact match against real data, and not a known typo — ambiguous. Never guess here.
  return { resolved: false, needsConfirmation: true, value: null, originalInput: input };
}
