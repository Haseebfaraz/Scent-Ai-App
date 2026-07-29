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

function classifyNote(note) {
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

/**
 * @param {string[]} allNotes - every real note across every real component product in the
 *   combination, already deduplicated by the caller if desired (duplicates are also removed here
 *   defensively — "No duplicates within the same slider").
 * @returns {{ top: string[], middle: string[], base: string[] }} exact original spelling preserved;
 *   each array capped at 5, and topped up to a minimum of 3 (when enough real notes exist overall)
 *   by borrowing from whichever other bucket has the most surplus — never invented, only moved.
 */
export function assignNotePositions(allNotes) {
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
      overflow.push(...buckets[position].slice(MAX_NOTES_PER_POSITION));
      buckets[position] = buckets[position].slice(0, MAX_NOTES_PER_POSITION);
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
