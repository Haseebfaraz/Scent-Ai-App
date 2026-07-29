// Fragrance family/note-compatibility config — the deterministic "controlled note and family
// mappings" the product spec requires to live in code, not in the system prompt. Two tiers:
//
// 1. PREFERENCE_FAMILIES — the five families the spec explicitly names in Phase 3, used to match
//    a customer's stated likes/dislikes against a product's real notes.
// 2. COMPATIBILITY_TAGS — the additional descriptors Phase 6's "note compatibility guidance" and
//    risk rules reference (floral, musk, woody, amber, aquatic, aromatic, smoky, citrus). The spec
//    never lists concrete notes for these (they're industry shorthand, not literal note text), so
//    each is grounded in real note words actually present in the imported FragranceProduct catalog
//    (confirmed via a live query during Stage A verification) rather than invented.
//
// Every keyword list is matched as a case-insensitive substring against a product's real notes —
// never used to infer notes a product doesn't actually have.

export const PREFERENCE_FAMILIES = {
  // Spec: mango, pineapple, pear, apple, berries, strawberry, peach, apricot, guava, black
  // currant, fig. "berr" (not just "strawberry") is used so it also catches "Raspberry" and any
  // other real berry note under the spec's own "berries" example. "fruity" itself is included
  // because the real catalog uses generic notes like "Fruity Notes" as a catch-all entry.
  fruity: [
    "fruity", "mango", "pineapple", "pear", "apple", "berr", "strawberry", "peach",
    "apricot", "guava", "black currant", "blackcurrant", "fig",
  ],
  // Spec: vanilla, sugar, marshmallow, cotton candy, caramel, honey, tonka, whipped cream.
  sweet: [
    "sweet", "vanilla", "sugar", "marshmallow", "cotton candy", "caramel",
    "honey", "tonka", "whipped cream",
  ],
  // Spec: citrus, aquatic, green, mint, neroli, aromatic freshness. Concrete citrus notes
  // (bergamot, lemon, lime, mandarin, grapefruit, orange, tangerine) are added so "citrus" is
  // actually detectable against real note text, which rarely spells out the word "citrus" itself.
  fresh: [
    "fresh", "citrus", "bergamot", "lemon", "lime", "mandarin", "grapefruit",
    "orange", "tangerine", "aquatic", "marine", "green", "mint", "neroli", "aromatic",
  ],
  // Spec: pepper, saffron, clove, cinnamon, cardamom, coriander, ginger, nutmeg, cumin.
  // "spice"/"spicy" added because the real catalog uses a generic "Spices"/"Spicy Notes" entry as
  // a catch-all note. "pepper" alone (substring) already catches "black pepper"/"pink pepper".
  spicy: ["spicy", "spice", "pepper", "saffron", "clove", "cinnamon", "cardamom", "coriander", "ginger", "nutmeg", "cumin"],
  // Spec: oud, smoke, leather, dense amber, tobacco, heavy resins, very intense woods.
  // "agarwood" added — it's the raw wood oud is distilled from, and appears in the real catalog.
  // "strong"/"heavy" added for matching the customer's own words (verified against the full real
  // note vocabulary: neither word appears in any real note, so this adds no false note-matches).
  strongHeavy: [
    "strong", "heavy", "oud", "agarwood", "smoke", "smoky", "leather", "amber",
    "tobacco", "resin", "incense",
  ],
  // Added so a customer stating "I like woody/musk" (or a refinement request naming one) is a real,
  // matchable family here — not just a COMPATIBILITY_TAGS entry usable for pair-compatibility only.
  woody: ["woody", "wood", "sandalwood", "cedar", "vetiver", "patchouli", "guaiac"],
  musk: ["musk", "musky"],
};

// `fruity`/`sweet`/`fresh`/`spicy`/`strongHeavy` keywords above double as matchers for both real
// product notes ("Sweet Cherry", "Fresh Jasmine") AND a customer's own short preference words
// ("sweet", "fresh") via the same detectFamilies() call — a note like "Fresh Jasmine" genuinely
// carries both a fresh and floral character, so the overlap is accurate, not a false positive.

export const COMPATIBILITY_TAGS = {
  citrus: ["citrus", "bergamot", "lemon", "lime", "mandarin", "grapefruit", "orange", "tangerine"],
  floral: [
    "jasmine", "rose", "violet", "iris", "tuberose", "magnolia", "freesia",
    "gardenia", "peony", "ylang", "osmanthus", "orange blossom",
  ],
  musk: ["musk"],
  vanilla: ["vanilla"],
  aquatic: ["aquatic", "marine"],
  woody: ["wood", "sandalwood", "cedar", "vetiver", "patchouli", "guaiac"],
  aromatic: ["aromatic", "lavender", "rosemary", "sage", "basil", "thyme"],
  smoky: ["smoke", "smoky", "incense", "oud", "agarwood"],
  amber: ["amber", "ambergris", "ambroxan", "labdanum"],
};

// Returns every family/tag in familyMap whose keyword list matches at least one of `notes`.
export function detectFamilies(notes, familyMap) {
  const noteText = (Array.isArray(notes) ? notes : []).join(" | ").toLowerCase();
  if (!noteText) return [];
  return Object.entries(familyMap)
    .filter(([, keywords]) => keywords.some((kw) => noteText.includes(kw)))
    .map(([family]) => family);
}

// Maps a customer's own short preference words (likes/dislikes, e.g. "Fruity", "Strong") to
// PREFERENCE_FAMILIES keys, via the same keyword lists (each family's keywords include its own
// plain-English name — see the comments above). Shared by orderHistoryAnalysis.server.js and
// recommendationEngine.server.js so both interpret a customer's stated preferences identically.
export function textToPreferenceFamilies(strings) {
  const families = new Set();
  for (const s of strings || []) {
    if (!s) continue;
    for (const f of detectFamilies([s], PREFERENCE_FAMILIES)) families.add(f);
  }
  return [...families];
}

// Phase 6 "note compatibility guidance" — each pair is a PREFERENCE_FAMILIES or
// COMPATIBILITY_TAGS key. The spec's "Gourmand + vanilla" rule has no separate "gourmand" family
// defined anywhere in Phase 3 — DUA's gourmand direction is exactly the `sweet` family's own note
// list (vanilla, sugar, marshmallow, caramel, honey, tonka, whipped cream), so it's represented as
// sweet+vanilla rather than invented as a new, undefined family.
export const COMPATIBLE_PAIRS = [
  ["fruity", "citrus"],
  ["fruity", "floral"],
  ["fruity", "musk"],
  ["fruity", "vanilla"],
  ["sweet", "citrus"], // "Sweet + fresh citrus"
  ["sweet", "vanilla"], // "Gourmand + vanilla"
  ["aquatic", "woody"],
  ["floral", "musk"],
  ["citrus", "aromatic"],
  ["smoky", "amber"],
  ["woody", "amber"],
  // Added: supported spicy directions (aquatic+cardamom, ginger+bergamot, mint+coriander,
  // vanilla+controlled spice, woody+fresh citrus, lavender+cardamom, pear+pink pepper).
  ["aquatic", "spicy"],
  ["citrus", "spicy"],
  ["fresh", "spicy"],
  ["vanilla", "spicy"],
  ["woody", "citrus"],
  ["aromatic", "spicy"],
  ["fruity", "spicy"],
];

export function pairIsCompatible(familyA, familyB) {
  return COMPATIBLE_PAIRS.some(
    ([a, b]) => (a === familyA && b === familyB) || (a === familyB && b === familyA),
  );
}

// Phase 6 risk rules. Each takes the list of products in a proposed combination (each shaped as
// { title, notes: string[] }) and returns a risk message, or null if that risk isn't present.
// Detection is by literal note keywords only — never inferred from a product title or category.
export const RISK_RULES = [
  {
    id: "excessive_gourmand_heat",
    // "Excessive sugar + caramel + marshmallow + honey in hot weather" — the weather condition is
    // evaluated by the caller (recommendationEngine), which passes `season` in.
    check(products, { season } = {}) {
      if (season !== "Summer") return null;
      const gourmandKeywords = ["sugar", "caramel", "marshmallow", "honey"];
      const hits = products.filter((p) =>
        gourmandKeywords.some((kw) => (p.notes || []).join(" ").toLowerCase().includes(kw)),
      );
      return hits.length >= 2
        ? "Multiple heavy sugar/caramel/marshmallow/honey notes may feel too heavy in summer heat"
        : null;
    },
  },
  {
    id: "multiple_heavy_components",
    check(products) {
      const heavy = products.filter(
        (p) => detectFamilies(p.notes, PREFERENCE_FAMILIES).includes("strongHeavy"),
      );
      return heavy.length >= 2
        ? "Multiple heavy oud/leather/smoke/tobacco/resin components may overwhelm the blend"
        : null;
    },
  },
  {
    id: "competing_fruits",
    check(products) {
      const fruity = products.filter(
        (p) => detectFamilies(p.notes, PREFERENCE_FAMILIES).includes("fruity"),
      );
      return fruity.length >= 3
        ? "Several strongly fruity products may compete rather than layer cleanly"
        : null;
    },
  },
  {
    id: "spice_conflict",
    check(products) {
      const spicy = products.filter(
        (p) => detectFamilies(p.notes, PREFERENCE_FAMILIES).includes("spicy"),
      );
      return spicy.length >= 2 ? "Multiple spicy products may clash rather than complement" : null;
    },
  },
  {
    id: "citrus_smoke_clash",
    check(products) {
      const hasCitrus = products.some((p) => detectFamilies(p.notes, COMPATIBILITY_TAGS).includes("citrus"));
      const hasSmoke = products.some((p) => detectFamilies(p.notes, COMPATIBILITY_TAGS).includes("smoky"));
      return hasCitrus && hasSmoke
        ? "Sharp citrus alongside dense smoky notes can clash without a bridging note"
        : null;
    },
  },
  {
    id: "quadbrid_complexity",
    check(products) {
      return products.length >= 4
        ? "Four products in one blend raises the risk of a muddled, over-complex result"
        : null;
    },
  },
  {
    id: "duplicate_direction",
    check(products) {
      const directionCounts = {};
      for (const p of products) {
        for (const family of detectFamilies(p.notes, PREFERENCE_FAMILIES)) {
          directionCounts[family] = (directionCounts[family] || 0) + 1;
        }
      }
      const duplicated = Object.entries(directionCounts).find(([, count]) => count === products.length && products.length > 1);
      return duplicated
        ? `Every product shares the same "${duplicated[0]}" direction with no contrasting role`
        : null;
    },
  },
];

export function assessCombinationRisks(products, context = {}) {
  return RISK_RULES.map((rule) => rule.check(products, context)).filter(Boolean);
}
