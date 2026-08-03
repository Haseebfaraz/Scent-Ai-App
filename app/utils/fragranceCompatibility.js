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
  // Fix (powdery family) — orris/iris/violet/heliotrope/powder give a cosmetic-powder impression.
  // "almond" is deliberately NOT listed here: on its own it reads as plain nutty, only becoming
  // powdery (or gourmand) in combination with other real notes — see classifyAlmondCharacter below,
  // which is the single place that contextual read is decided.
  powdery: ["powdery", "orris", "iris", "violet", "heliotrope", "powder"],
};

// Fix (powdery family) — "almond" alone is a plain nutty note; it only reads as powdery or
// gourmand alongside the real notes that actually give it that character in perfumery. Kept as its
// own explicit function (not folded into the `powdery` keyword list) so a product containing only
// almond can never count toward powdery-overload on its own — every caller that cares about an
// almond-bearing product's real character should call this rather than assume from "almond" alone.
const ALMOND_POWDERY_CONTEXT = ["orris", "iris", "violet", "heliotrope"];
const ALMOND_GOURMAND_CONTEXT = ["vanilla", "tonka", "caramel", "honey"];
export function classifyAlmondCharacter(notes) {
  const noteText = (Array.isArray(notes) ? notes : []).join(" | ").toLowerCase();
  if (!noteText.includes("almond")) return null;
  if (ALMOND_POWDERY_CONTEXT.some((kw) => noteText.includes(kw))) return "powdery";
  if (ALMOND_GOURMAND_CONTEXT.some((kw) => noteText.includes(kw))) return "gourmand";
  return "nutty";
}

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

// Fix (literal note terms lost to family-level matching) — a customer who names specific notes
// ("Apple", "Strawberry", "Peach") has all three collapsed into one `fruity` family tag by
// textToPreferenceFamilies above, so a product matching via unrelated fruity notes (e.g. Pear,
// Blackcurrant) scores identically to one containing what the customer actually named. These are
// the family keywords that are themselves just a generic style/descriptor word, not a specific real
// note — excluded here so "Fruity"/"Fresh" don't count as literal note terms, only "Apple" etc do.
const FAMILY_DESCRIPTOR_WORDS = new Set([
  "fruity", "sweet", "fresh", "spicy", "spice", "strong", "heavy", "woody", "musk", "musky", "powdery",
]);

// Extracts the specific real-note keyword(s) each liked string actually matched (skipping pure
// descriptor words), so a caller can prefer/boost products that genuinely contain the customer's
// named notes over ones that only share the broader family.
export function literalNoteTermsFromLikes(strings) {
  const terms = new Set();
  for (const s of strings || []) {
    if (!s) continue;
    const lower = String(s).toLowerCase();
    for (const keywords of Object.values(PREFERENCE_FAMILIES)) {
      for (const kw of keywords) {
        if (!FAMILY_DESCRIPTOR_WORDS.has(kw) && lower.includes(kw)) terms.add(kw);
      }
    }
  }
  return [...terms];
}

// How many of a product's real notes literally contain one of the customer's named terms — a
// tie-breaker on top of family-level matching, never a replacement for it (a product still needs a
// real, existing catalog match; this only decides which of several family-matching products wins).
export function literalNoteMatchCount(notes, literalTerms) {
  if (!literalTerms?.length || !notes?.length) return 0;
  const noteText = notes.join(" | ").toLowerCase();
  return literalTerms.filter((term) => noteText.includes(term)).length;
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
    id: "powdery_overload",
    check(products) {
      const powdery = products.filter((p) => detectFamilies(p.notes, PREFERENCE_FAMILIES).includes("powdery"));
      return powdery.length >= 2
        ? "Multiple powdery orris/iris/violet/heliotrope notes may build into a heavy, cosmetic-powder impression"
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

// ============================================================
// Deterministic natural-language preference interpretation
// ============================================================
// Fix (Aniq regression) — the engine was treating a customer's own free-text complaint ("scents
// that hit my nose and make me feel headache") as pure customer-facing color with zero effect on
// which products get selected. This is a phrase-detection layer, NOT an LLM call — it must produce
// the same structured constraints every time for the same input, since these feed hard filters
// (Fix: hard sensitivity filters), not just narration.

// Deliberately phrase-based rather than single-keyword — "heavy" alone is common enough in
// unrelated text that it's only included alongside the other, more specific complaint phrasing.
const SENSITIVITY_PHRASES = [
  /hit(s)?\s*my\s*nose/i,
  /headache/i,
  /migraine/i,
  /\bsharp\b/i,
  /\bpiercing\b/i,
  /\bharsh\b/i,
  /too\s*strong/i,
  /overpowering/i,
  /suffocat/i,
  /\bheavy\b/i,
  /haddik/i, // spec's own informal/misspelled example — kept literal, not "corrected" into a guess
  /uncomfortable/i,
  /cannot tolerate|can'?t tolerate/i,
  /sensitive (nose|to (scent|smell|fragrance|perfume))/i,
];

// The exact real-note keywords behind each "risk-driving direction" the spec names — reused by both
// interpretCustomerPreferences (to translate avoidedDirections into real matchable text) and
// recommendationEngine.server.js's per-product intensity-driver detection (Fix 6/multi-dimensional
// roles). Deliberately real note substrings, never a family name alone, so a match is always
// traceable to an actual word in the product's real notesJson.
export const DIRECTION_RISK_NOTES = {
  "pepper-heavy": ["black pepper", "pink pepper", "pepper"],
  "dense-spicy": ["saffron", "cinnamon", "cumin", "clove"],
  smoky: ["smoke", "incense"],
  oud: ["oud", "agarwood"],
  leather: ["leather"],
  tobacco: ["tobacco"],
  "heavy-amber": ["labdanum", "ambergris", "ambroxan", "amberwood", "amber"],
  resinous: ["resin"],
  "dense-patchouli": ["patchouli"],
  "strong-guaiac": ["guaiac"],
};

// Real note keywords that soften/calm a blend — used to populate a product's softeningNotes.
export const SOFTENING_NOTE_KEYWORDS = [
  "lavender", "sandalwood", "vanilla", "musk", "chamomile", "sea salt", "tea", "aloe",
  "white musk", "clean musk", "linen", "cotton", "powder", "iris", "neroli", "mint",
];

// A customer's preferred STYLE word maps to a bundle of fragrance directions — a documented,
// general judgment call (not specific to any one customer), matching the spec's own "relaxing ->
// airy/clean/watery/green-tea/soft-musky/light-fruity" example bundle.
const STYLE_DIRECTION_MAP = [
  {
    pattern: /relax|calm|soothing|gentle|soft|easy|comfort/i,
    preferredDirections: ["relaxing", "airy", "clean", "watery", "green-tea", "soft-musky", "light-fruity"],
  },
  {
    pattern: /energetic|active|sport|bold|confident|invigorat/i,
    preferredDirections: ["energetic", "crisp", "citrus-forward", "bright"],
  },
  {
    pattern: /elegant|sophisticat|formal|professional/i,
    preferredDirections: ["refined", "polished", "understated"],
  },
  {
    pattern: /playful|fun\b/i,
    preferredDirections: ["playful", "sweet", "gourmand-light"],
  },
];

const BASE_SENSITIVITY_AVOID_DIRECTIONS = [
  "sharp", "piercing", "pepper-heavy", "dense-spicy", "smoky", "heavy-amber",
  "resinous", "oud", "leather", "tobacco", "overly-complex",
];

/**
 * Deterministic interpretation of a customer's free-text signals (dislikes, additionalPreferences,
 * preferredStyle/inferredStyle) into structured recommendation constraints. Pure phrase-matching —
 * no LLM call, no randomness — so the same profile always produces the same constraints, and hard
 * filters downstream can depend on it directly.
 * @param {object} profile
 * @returns {{preferredDirections: string[], avoidedDirections: string[], strengthPreference: string|null,
 *   sensitivityLevel: "high"|"none", preferSimpleCombinations: boolean, preferredCombinationTypes: string[]}}
 */
export function interpretCustomerPreferences(profile) {
  const additionalText = Array.isArray(profile?.additionalPreferences)
    ? profile.additionalPreferences.join(" . ")
    : (profile?.additionalPreferences || "");
  const textBlob = [
    ...(profile?.dislikes || []),
    additionalText,
    profile?.preferredStyle,
    profile?.inferredStyle,
  ].filter(Boolean).join(" . ");

  const sensitivityHit = SENSITIVITY_PHRASES.some((re) => re.test(textBlob));
  const styleMatch = STYLE_DIRECTION_MAP.find((s) => s.pattern.test(textBlob));

  return {
    preferredDirections: styleMatch ? [...styleMatch.preferredDirections] : [],
    avoidedDirections: sensitivityHit ? [...BASE_SENSITIVITY_AVOID_DIRECTIONS] : [],
    strengthPreference: sensitivityHit ? "light" : (profile?.strengthPreference || null),
    sensitivityLevel: sensitivityHit ? "high" : "none",
    preferSimpleCombinations: sensitivityHit,
    preferredCombinationTypes: sensitivityHit ? ["HYBRID"] : [],
  };
}

// Fix 5 — deterministic complexity bands from a real note count, per the spec's own thresholds.
export function computeComplexityLevel(noteCount) {
  if (noteCount <= 6) return "low";
  if (noteCount <= 12) return "moderate";
  if (noteCount <= 20) return "high";
  return "very-high";
}

// Real matched risk-note keywords present in a product's own notes (not a family label) — the
// per-product "intensity drivers" the multi-dimensional role classifier and hard filters both need.
export function detectIntensityDrivers(notes) {
  const noteText = (Array.isArray(notes) ? notes : []).join(" | ").toLowerCase();
  const hits = [];
  for (const keywords of Object.values(DIRECTION_RISK_NOTES)) {
    for (const kw of keywords) {
      if (noteText.includes(kw) && !hits.includes(kw)) hits.push(kw);
    }
  }
  return hits;
}

export function detectSofteningNotes(notes) {
  const noteText = (Array.isArray(notes) ? notes : []).join(" | ").toLowerCase();
  return SOFTENING_NOTE_KEYWORDS.filter((kw) => noteText.includes(kw));
}

// Fix 4 (Aniq spec) — a hard, pre-generation filter shared by both the candidate-scoring stage
// (orderHistoryAnalysis.server.js) and combination generation (recommendationEngine.server.js), so
// a highly sensitive customer never has an intense product enter EITHER an anchor or a support
// shortlist in the first place. Deliberately NOT triggered by a single strong note — only several
// real intensity-driver matches, or genuinely very-high complexity, disqualify a product outright.
const INTENSITY_DRIVER_HARD_LIMIT = 3;
export function passesIntensityFilter(notes, preferenceIntent) {
  if (!preferenceIntent || preferenceIntent.sensitivityLevel !== "high") return true;
  if (computeComplexityLevel((notes || []).length) === "very-high") return false;
  return detectIntensityDrivers(notes).length < INTENSITY_DRIVER_HARD_LIMIT;
}

// Real note keywords behind each "preferredDirections" label interpretCustomerPreferences can
// produce — lets a preferred STYLE (e.g. "relaxing") actually score real products higher, rather
// than only ever affecting customer-facing copy (Test 2's exact requirement).
export const PREFERRED_DIRECTION_MATCHERS = {
  relaxing: ["lavender", "chamomile", "tea", "musk"],
  airy: ["aquatic", "marine", "citrus", "green"],
  clean: ["musk", "clean", "linen", "cotton", "soap"],
  watery: ["aquatic", "marine", "sea salt", "water"],
  "green-tea": ["tea", "green"],
  "soft-musky": ["musk"],
  "light-fruity": ["fruity", "pear", "apple", "berr", "peach", "mango", "pineapple"],
  energetic: ["citrus", "mint", "bergamot"],
  crisp: ["citrus", "aquatic", "green"],
  "citrus-forward": ["citrus", "bergamot", "lemon", "orange"],
  bright: ["citrus", "fruity"],
  refined: ["musk", "iris", "sandalwood"],
  polished: ["musk", "sandalwood"],
  understated: ["musk", "clean"],
  playful: ["fruity", "sweet"],
  sweet: ["sweet", "vanilla"],
  "gourmand-light": ["vanilla", "sugar"],
};

// How many of a product's REAL notes match the customer's preferred style directions — a real,
// deterministic scoring signal (not just customer-facing wording) so a preferred style actually
// outranks a historically-popular-but-mismatched product (Test 2).
export function countPreferredDirectionMatches(notes, preferredDirections) {
  if (!preferredDirections?.length) return 0;
  const noteText = (Array.isArray(notes) ? notes : []).join(" | ").toLowerCase();
  if (!noteText) return 0;
  let count = 0;
  for (const direction of preferredDirections) {
    const keywords = PREFERRED_DIRECTION_MATCHERS[direction];
    if (keywords?.some((kw) => noteText.includes(kw))) count++;
  }
  return count;
}

// ============================================================
// Lifestyle / occasion context interpretation
// ============================================================
// Deterministic phrase-based lifestyle classification from the customer's own occasion/
// additionalPreferences text — same approach as interpretCustomerPreferences (no LLM call, same
// input always produces the same output). Unlike STYLE_DIRECTION_MAP (which picks the FIRST
// matching style), a customer can genuinely describe more than one lifestyle at once ("I work in
// an office, hit the gym after, then like to unwind") — every matching category contributes,
// weighted by 1/(number matched) so no single category silently drowns out the others (a "weighted
// intersection," not a first-match-wins pick). Every preferredDirections/avoidedDirections value
// used below is a real key already present in PREFERRED_DIRECTION_MATCHERS/DIRECTION_RISK_NOTES —
// this reuses those existing note-keyword mappings rather than inventing a parallel vocabulary.
const LIFESTYLE_PATTERNS = [
  {
    name: "office",
    // "safety officer" is an occupation implying a professional/workplace context, not a literal
    // office — \bofficer\b matching it directly is the intended behavior, not a false positive.
    pattern: /\boffice\b|\bofficer\b|\bwork(ing)?\b|\bprofessional\b|\bworkplace\b|\bmeeting\b|\bcorporate\b/i,
    preferredDirections: ["clean", "polished", "understated", "refined"],
    avoidedDirections: ["smoky", "dense-spicy", "heavy-amber"],
  },
  {
    name: "gym",
    pattern: /\bgym\b|\bworkout\b|\bwork\s*out\b|\bexercis(e|ing)\b|\bactive\b|\bsport(s)?\b|\btraining\b|\brunning\b/i,
    preferredDirections: ["airy", "crisp", "citrus-forward", "watery"],
    avoidedDirections: ["heavy-amber", "resinous", "dense-spicy", "smoky"],
  },
  {
    name: "relaxation",
    pattern: /\brelax|\bcalm|\bunwind|\bsoothing\b|\bgentle\b|\beasy\b|\bcomfort\b|\bcozy\b/i,
    preferredDirections: ["relaxing", "soft-musky", "green-tea"],
    avoidedDirections: ["smoky", "pepper-heavy"],
  },
  {
    name: "daytime",
    pattern: /\bdaytime\b|\bday\s*wear\b|\bmorning\b|\bafternoon\b/i,
    preferredDirections: ["airy", "light-fruity", "crisp"],
    avoidedDirections: ["heavy-amber"],
  },
  {
    name: "evening",
    pattern: /\bevening\b|\bnight\s*(out|wear)?\b|\bdate\b|\bformal\b|\bdinner\b/i,
    preferredDirections: ["refined", "playful"],
    avoidedDirections: [],
  },
  {
    name: "outdoor-heat",
    pattern: /\boutdoor\b|\bbeach\b|\bsummer\s*heat\b|\bhot\s*weather\b|\bhumid\b/i,
    preferredDirections: ["airy", "watery", "crisp"],
    avoidedDirections: ["heavy-amber", "dense-spicy", "resinous"],
  },
  {
    name: "special-event",
    pattern: /\bwedding\b|\bspecial\s*event\b|\bcelebration\b|\bparty\b|\bgala\b/i,
    preferredDirections: ["playful", "refined"],
    avoidedDirections: [],
  },
];

/**
 * @param {object} profile
 * @returns {{lifestyles: string[], preferredDirections: Map<string, number>, avoidedDirections: Map<string, number>}}
 *   Maps are direction -> accumulated weight (each matched lifestyle contributes 1/matchCount).
 */
export function interpretLifestyleContext(profile) {
  const textBlob = [
    profile?.occasion,
    Array.isArray(profile?.additionalPreferences) ? profile.additionalPreferences.join(" . ") : profile?.additionalPreferences,
  ].filter(Boolean).join(" . ");

  const matched = LIFESTYLE_PATTERNS.filter((l) => l.pattern.test(textBlob));
  if (!matched.length) return { lifestyles: [], preferredDirections: new Map(), avoidedDirections: new Map() };

  const weight = 1 / matched.length;
  const preferredDirections = new Map();
  const avoidedDirections = new Map();
  for (const lifestyle of matched) {
    for (const d of lifestyle.preferredDirections) preferredDirections.set(d, (preferredDirections.get(d) || 0) + weight);
    for (const d of lifestyle.avoidedDirections) avoidedDirections.set(d, (avoidedDirections.get(d) || 0) + weight);
  }
  return { lifestyles: matched.map((l) => l.name), preferredDirections, avoidedDirections };
}

// How many of the customer's specific avoidedDirections (e.g. from a high-sensitivity profile)
// this product's real notes actually hit — reuses DIRECTION_RISK_NOTES so "oud"/"leather"/etc. map
// to the same real keywords the hard pre-generation filter already uses, restricted to only the
// directions THIS customer actually avoids (never a blanket penalty for every possible direction).
export function countAvoidedDirectionMatches(notes, avoidedDirections) {
  if (!avoidedDirections?.length) return 0;
  const noteText = (Array.isArray(notes) ? notes : []).join(" | ").toLowerCase();
  if (!noteText) return 0;
  let count = 0;
  for (const direction of avoidedDirections) {
    const keywords = DIRECTION_RISK_NOTES[direction];
    if (keywords?.some((kw) => noteText.includes(kw))) count++;
  }
  return count;
}
