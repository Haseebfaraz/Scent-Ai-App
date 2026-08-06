import { PREFERENCE_FAMILIES, containsWholeWord } from "./fragranceCompatibility.js";

const LITERAL_MATCH_RANK = 2;
const FAMILY_MATCH_RANK = 1;

// Deterministic Top/Middle/Base note-position bucketing — the single reusable utility the slider
// preview page (and any other consumer) must use, per the explicit requirement: "This mapping must
// be maintained in one reusable utility rather than duplicated in frontend code." Never invents a
// note or changes its wording — every note returned is copied verbatim from the real notesJson
// already in the catalog; this only decides which of the three display groups each real note falls
// into, using its own keyword content, never randomly.
//
// This is a NOTE-level classification, not a per-PRODUCT one: a Hybrid/Tribrid/Quadbrid's real
// component products (2-4 of them) each contribute their own real notes into one shared pool, which
// is then split into exactly three display groups (Top/Middle/Base) — independent of how many real
// products the combination actually has, and independent of the internal role/family scoring
// (Freshness/Sweetness/Musk-wood base/etc.) used elsewhere for combination generation.

// Order matters: each keyword list is checked top-to-bottom, first match wins, so a note that could
// arguably fit two buckets (e.g. a floral note that's also faintly green) resolves deterministically
// and consistently every time, never by chance.
// "green" itself is deliberately NOT a top keyword — "Green Tea" is an explicit middle-note example
// in the spec's own worked example, so a bare "green" substring would misclassify it. "galbanum" (a
// real, specific green top note) is used instead of the ambiguous generic word.
const TOP_KEYWORDS = [
  "citrus", "bergamot", "lemon", "lime", "mandarin", "grapefruit", "orange", "tangerine",
  "fresh", "aquatic", "marine", "sea salt", "galbanum", "mint", "neroli", "petitgrain",
  "aromatic", "sicilian", "calabrian", "amalfi",
];
const MIDDLE_KEYWORDS = [
  "floral", "jasmine", "rose", "violet", "iris", "tuberose", "magnolia", "freesia",
  "gardenia", "peony", "ylang", "osmanthus", "orange blossom", "geranium", "lavender",
  "tea", "green tea", "herbal", "sage", "basil", "thyme", "rosemary",
  "spice", "spicy", "cardamom", "coriander", "pink pepper", "cinnamon",
  "pear", "peach", "apricot", "berr", "strawberry", "raspberry", "fig", "apple", "pineapple", "mango",
];
const BASE_KEYWORDS = [
  "musk", "wood", "sandalwood", "cedar", "vetiver", "patchouli", "guaiac", "oud", "agarwood",
  "vanilla", "benzoin", "amber", "ambergris", "ambroxan", "labdanum", "moss", "oakmoss",
  "resin", "incense", "leather", "tobacco", "tonka", "musky",
];

// Exported so per-product price attribution (fragranceBuild.server.js) can classify a single
// product's own notes with the exact same keyword rules used for the merged display buckets below,
// without duplicating TOP/MIDDLE/BASE_KEYWORDS or reimplementing the classification logic.
export function classifyNote(note) {
  const lower = String(note).toLowerCase();
  if (TOP_KEYWORDS.some((kw) => lower.includes(kw))) return "top";
  if (MIDDLE_KEYWORDS.some((kw) => lower.includes(kw))) return "middle";
  if (BASE_KEYWORDS.some((kw) => lower.includes(kw))) return "base";
  // A real note matching none of the three keyword lists still needs a deterministic home —
  // "middle" (the fragrance heart) is the documented, conservative default rather than silently
  // dropping it or guessing between top/base.
  return "middle";
}

const MIN_NOTES_PER_POSITION = 3;
const MAX_NOTES_PER_POSITION = 5;

// Fix (customer's own liked notes silently dropped from display) — when a bucket has more than 5
// real notes, the cap used to keep whichever 5 happened to appear FIRST in arrival order (anchor's
// notes, then each support product's notes, in order) — with zero regard for whether any of them
// matched what the customer actually said they like. Confirmed live: a customer who liked "Fruity"
// (matching real Apple/Pear notes in the actual selected combination) never saw Apple anywhere on
// the preview page, because unrelated default-bucketed notes ("Lily of the Valley", "Ambrette" —
// nothing in TOP/MIDDLE/BASE_KEYWORDS matched them, so classifyNote's own middle-bucket fallback
// caught them) happened to appear earlier in the note list and filled the 5-slot cap first. Sorting
// liked-family matches to the front before slicing means the customer's own stated likes are never
// the ones arbitrarily cut for display, without changing WHICH position a note belongs to or
// inventing/reordering anything beyond this cap.
// Fix (literal note terms lost to family-level matching) — a note literally matching one of the
// customer's own named terms (e.g. "Peach") now outranks one that only matches the broader family
// (e.g. "Pear", also `fruity`) — previously both ranked identically as long as either was "liked".
// Fix (preview prioritization let Apple match Pineapple) — the literal-term branch used plain
// `.includes()`, unlike every other literal-term matcher in this codebase (literalNoteMatchCount/
// matchedLiteralTerms/missingLiteralTerms all use containsWholeWord) — confirmed the exact same
// bug class as the real Apple/Pineapple substring bug those were fixed for, just in this one
// preview-display code path that never got the word-boundary fix. Family-level matching below
// intentionally stays substring-based (that's the established, accepted design for broad family
// detection everywhere else — see detectFamilies).
function noteLikeRank(note, likeFamilies, literalTerms) {
  if (literalTerms?.length && literalTerms.some((term) => containsWholeWord(note, term))) return LITERAL_MATCH_RANK;
  const lower = String(note).toLowerCase();
  if (likeFamilies?.length && likeFamilies.some((family) => {
    const keywords = PREFERENCE_FAMILIES[family];
    return keywords && keywords.some((kw) => lower.includes(kw));
  })) return FAMILY_MATCH_RANK;
  return 0;
}

function prioritizeLikedNotes(notes, likeFamilies, literalTerms) {
  if (!likeFamilies?.length && !literalTerms?.length) return notes;
  // Array.prototype.sort is a stable sort as of ES2019/Node 11+ — ties (matching the same rank)
  // keep their original relative order, only rank differences get reordered.
  return [...notes].sort((a, b) => noteLikeRank(b, likeFamilies, literalTerms) - noteLikeRank(a, likeFamilies, literalTerms));
}

/**
 * @param {string[]} allNotes - every real note across every real component product in the
 *   combination, already deduplicated by the caller if desired (duplicates are also removed here
 *   defensively — "No duplicates within the same slider").
 * @param {string[]} [likeFamilies] - PREFERENCE_FAMILIES keys (e.g. from textToPreferenceFamilies)
 *   the customer actually stated liking — when a bucket exceeds the 5-note cap, notes matching one
 *   of these are kept over notes that don't, instead of whichever came first in arrival order.
 * @param {string[]} [literalTerms] - specific note keywords the customer actually named (e.g. from
 *   literalNoteTermsFromLikes) — ranked above a plain family match when both are present, so a real
 *   named note (e.g. "Peach") is never bumped by a merely same-family one (e.g. "Pear").
 * @returns {{ top: string[], middle: string[], base: string[] }} exact original spelling preserved;
 *   each array capped at 5, and topped up to a minimum of 3 (when enough real notes exist overall)
 *   by borrowing from whichever other bucket has the most surplus — never invented, only moved.
 */
export function assignNotePositions(allNotes, likeFamilies = [], literalTerms = []) {
  const seen = new Set();
  const deduped = (allNotes || []).filter((n) => {
    const key = String(n).trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const buckets = { top: [], middle: [], base: [] };
  for (const note of deduped) {
    buckets[classifyNote(note)].push(note);
  }

  // Cap each bucket at 5 first — anything trimmed goes into a shared overflow pool so a bucket
  // that's short can still be topped up from real, already-classified notes rather than reaching
  // into a different position's keyword territory.
  const overflow = [];
  for (const position of ["top", "middle", "base"]) {
    if (buckets[position].length > MAX_NOTES_PER_POSITION) {
      const ordered = prioritizeLikedNotes(buckets[position], likeFamilies, literalTerms);
      overflow.push(...ordered.slice(MAX_NOTES_PER_POSITION));
      buckets[position] = ordered.slice(0, MAX_NOTES_PER_POSITION);
    }
  }

  // Top up any bucket below the 3-note preference from the overflow pool, then (if still short)
  // from whichever other bucket has the most surplus above 3 — real notes only, never invented,
  // and a bucket only ever donates a note it can spare without dropping below 3 itself.
  for (const position of ["top", "middle", "base"]) {
    while (buckets[position].length < MIN_NOTES_PER_POSITION && overflow.length) {
      buckets[position].push(overflow.shift());
    }
  }
  for (const position of ["top", "middle", "base"]) {
    while (buckets[position].length < MIN_NOTES_PER_POSITION) {
      const donor = ["top", "middle", "base"]
        .filter((p) => p !== position && buckets[p].length > MIN_NOTES_PER_POSITION)
        .sort((a, b) => buckets[b].length - buckets[a].length)[0];
      if (!donor) break; // not enough real notes overall to fill every bucket to the minimum
      buckets[position].push(buckets[donor].pop());
    }
  }

  return buckets;
}
