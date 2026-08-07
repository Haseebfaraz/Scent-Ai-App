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
  // Fix (real customer named a real catalog note we didn't recognize) — confirmed live: "coconut"
  // is a real note that appears in the catalog (e.g. alongside Gin/Mojito in a Top Notes list), but
  // matched nothing in this family at all — a dislike naming it silently vanished (never persisted,
  // never excluded from the next recommendation) instead of being treated as the plain fruity/
  // tropical note it is.
  fruity: [
    "fruity", "mango", "pineapple", "pear", "apple", "berr", "strawberry", "peach",
    "apricot", "guava", "black currant", "blackcurrant", "fig", "coconut",
  ],
  // Spec: vanilla, sugar, marshmallow, cotton candy, caramel, honey, tonka, whipped cream.
  // Fix (real customers say "candy", not "cotton candy") — confirmed live: "candy" alone matched
  // nothing at all (only the two-word spec phrase did), so a customer's own most natural word for
  // this family was invisible to likes, dislikes, and refinement feedback alike.
  sweet: [
    "sweet", "vanilla", "sugar", "marshmallow", "cotton candy", "candy", "caramel",
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
  // Fix (sensory-direction words produced zero signal) — confirmed live: a customer whose ENTIRE
  // stated likes were "dry, earthy, natural" matched no family and no literal note anywhere in this
  // file, so their candidate pool fell back to pure regional popularity with zero input from what
  // they actually said — the resulting recommendations leaned sweet/spicy/amber, the opposite of
  // what they asked for. These three are genuine sensory DIRECTIONS, not single notes, so each
  // draws from a cluster of real note words that together produce that impression, deliberately
  // overlapping (vetiver/oakmoss/cedar/moss appear in more than one) rather than trying to force
  // three mutually-exclusive buckets onto directions that are naturally related.
  dry: ["dry", "vetiver", "oakmoss", "papyrus", "cedar", "dry wood", "black tea", "tobacco leaf", "birch", "mineral"],
  earthy: ["earthy", "earth", "vetiver", "oakmoss", "patchouli", "moss", "soil", "cypriol", "nagarmotha", "papyrus", "galbanum", "angelica", "mushroom", "forest floor"],
  // Fix (false positive) — confirmed live in testing: bare "tea" as a 3-letter substring matched
  // inside plain unrelated words ("no-TEA-tall"), the exact same substring-collision risk this
  // codebase already avoids elsewhere with word-boundary matching for literal terms — family-level
  // matching stays substring-based by design, so the fix here is a longer, safer phrase instead.
  natural: ["natural", "herb", "sage", "basil", "rosemary", "green tea", "black tea", "tea leaf", "sea salt", "moss", "vetiver", "green note", "fir", "cypress", "cedar", "botanical"],
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
// the family keywords that are themselves just a generic style/descriptor word, or a deliberately
// truncated catch-all fragment, rather than one specific real note — excluded here so "Fruity"/
// "Fresh"/"Citrus" don't count as literal note terms, only "Apple"/"Bergamot" etc do.
// "berr" is the fruity family's own catch-all fragment for catching Raspberry/Blackberry/etc under
// the spec's "berries" example — real, useful for FAMILY detection, but never a customer's literal
// named note on its own, so it must not stand in for a specific berry like "Strawberry".
const FAMILY_DESCRIPTOR_WORDS = new Set([
  "fruity", "sweet", "fresh", "spicy", "spice", "strong", "heavy", "woody", "musk", "musky", "powdery",
  "berr", "citrus", "aquatic", "marine", "green", "aromatic",
  // Fix (dry/earthy/natural direction families) — same reasoning as above: these are sensory
  // DIRECTIONS, not specific real notes, so they must never satisfy the literal-exact-note hard
  // gate in scoreProposedCombination (which requires a combo to literally contain a named real
  // note) — a customer saying "dry, earthy, natural" would otherwise reject every real combination
  // outright, since no actual catalog note is literally spelled "dry"/"earthy"/etc.
  "dry", "earthy", "natural", "earth", "soil", "herb", "mineral", "green note", "forest floor", "botanical", "dry wood",
]);

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Fix (Pineapple counted as Apple, any berry counted as Strawberry) — plain substring matching
// (`.includes`) treats "apple" as present inside "pineapple", and the same in reverse would let a
// customer's literal "Pineapple" also register the shorter keyword "apple" hiding inside it.
// Word-boundary matching (`\bterm\b`) fixes both directions: "apple" only matches the standalone
// word "Apple" (as in "Pink Lady Apple"), never the middle of "Pineapple" — confirmed live as a real
// bug during a targeted audit. Case-insensitive since callers already lowercase on one side or the
// other inconsistently; matching case-insensitively here removes that footgun entirely.
export function containsWholeWord(text, term) {
  return new RegExp(`\\b${escapeRegex(term)}\\b`, "i").test(text);
}

// Extracts the specific real-note keyword(s) each liked string actually matched (skipping pure
// descriptor words and generic catch-all fragments), so a caller can prefer/boost products that
// genuinely contain the customer's named notes over ones that only share the broader family.
// Normalized aliases/genuine note variants (if ever needed) belong in an explicit table here, never
// as an unrestricted substring match against a family's generic keyword list.
export function literalNoteTermsFromLikes(strings) {
  const terms = new Set();
  for (const s of strings || []) {
    if (!s) continue;
    const trimmed = String(s).trim();
    if (!trimmed) continue;
    for (const keywords of Object.values(PREFERENCE_FAMILIES)) {
      for (const kw of keywords) {
        if (!FAMILY_DESCRIPTOR_WORDS.has(kw) && containsWholeWord(trimmed, kw)) terms.add(kw);
      }
    }
  }
  return [...terms];
}

// Fix (exact-note dislike collapsed into whole-family dislike) — confirmed as a real gap: "I
// dislike Sandalwood" used to convert straight into the `woody` FAMILY (via textToPreferenceFamilies
// downstream), so a product loaded with Cedar/Vetiver/Patchouli — none of them Sandalwood — could
// still accumulate enough matched notes to hit classifyDislikeConflict's "high" severity and be
// hard-rejected, purely for sharing a family with the one note actually named. Splits each dislike
// phrase by what it actually names, per-phrase (same clause-by-clause approach
// deriveRefinementAdjustments already uses for refinement feedback): a genuine literal note goes to
// `exactNoteDislikes` (handled by a direct whole-word hard-exclusion elsewhere, see
// hasHardExcludedTerm in recommendationEngine.server.js — precise, never touches an un-named
// family sibling); a bare style/family word like "Woody fragrances" or "fruity" goes to
// `explicitFamilyDislikes` (keeps the existing broader, severity-scaled classifyDislikeConflict
// treatment — the customer named the whole family on purpose, so treating every family member as
// relevant there is correct, not a bug).
export function splitDislikesByExactness(dislikes) {
  const exactNoteDislikes = new Set();
  const explicitFamilyDislikes = new Set();
  for (const d of dislikes || []) {
    if (!d) continue;
    const literalTerms = literalNoteTermsFromLikes([d]);
    if (literalTerms.length) {
      literalTerms.forEach((t) => exactNoteDislikes.add(t));
    } else {
      textToPreferenceFamilies([d]).forEach((f) => explicitFamilyDislikes.add(f));
    }
  }
  return { exactNoteDislikes: [...exactNoteDislikes], explicitFamilyDislikes: [...explicitFamilyDislikes] };
}

// Fix (refinement could only recognize notes already in the curated PREFERENCE_FAMILIES vocabulary)
// — confirmed live: "dont want coconut" did nothing until "coconut" was hand-added to a family list,
// and the same silent no-op will recur for the next catalog note a customer names that isn't in any
// family's keywords yet (there are hundreds of real notes; this file will never enumerate them all).
// Checked instead against the SPECIFIC real notes of the recommendation actually being refined
// (always known at refinement time — it's exactly what's on screen) rather than a fixed global list,
// so any real note the customer can see and name is recognized, not just pre-approved ones.
// FAMILY_DESCRIPTOR_WORDS excluded here too, same reasoning as literalNoteTermsFromLikes above — a
// bare note that's actually a generic style word (e.g. a product literally listing "Musk" as one of
// its notes) must still fall back to the FAMILY-level exclusion, not be treated as one specific
// literal note, or "no musk" would stop catching "White Musk"/"Musky Amber" elsewhere in the catalog.
export function matchedRealNotesInText(text, realNotes) {
  if (!text || !realNotes?.length) return [];
  const seen = new Set();
  const matches = [];
  for (const note of realNotes) {
    const trimmed = String(note || "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key) || FAMILY_DESCRIPTOR_WORDS.has(key) || !containsWholeWord(text, trimmed)) continue;
    seen.add(key);
    matches.push(key);
  }
  return matches;
}

// How many of a product's real notes literally contain one of the customer's named terms — a
// tie-breaker on top of family-level matching, never a replacement for it (a product still needs a
// real, existing catalog match; this only decides which of several family-matching products wins).
export function literalNoteMatchCount(notes, literalTerms) {
  if (!literalTerms?.length || !notes?.length) return 0;
  const noteText = notes.join(" | ");
  return literalTerms.filter((term) => containsWholeWord(noteText, term)).length;
}

// Fix (final-batch preference coverage) — literalNoteMatchCount above only ever returns a COUNT;
// checking whether EVERY customer-named note appears somewhere across a whole batch of
// recommendations (not just any one of them) needs to know WHICH specific terms matched or didn't.
export function matchedLiteralTerms(notes, literalTerms) {
  if (!literalTerms?.length || !notes?.length) return [];
  const noteText = notes.join(" | ");
  return literalTerms.filter((term) => containsWholeWord(noteText, term));
}

export function missingLiteralTerms(notes, literalTerms) {
  if (!literalTerms?.length) return [];
  const noteText = (notes || []).join(" | ");
  return literalTerms.filter((term) => !containsWholeWord(noteText, term));
}

// Fix (tiered exact-note coverage scoring) — a flat per-match boost treated a customer's 1st and
// 4th named note as equally significant. Distinct literal-note coverage now scores on a diminishing
// tier instead: 1st distinct note covered +10, 2nd +7, 3rd (and every one beyond) +5 — always a
// bigger, more decisive signal than the flat family-level bonus (SCORE_WEIGHTS.matchesLike = 5 per
// matched family), per the explicit requirement that broad family/style matching stay the smaller
// score. `distinctMatchCount` must already be a count of DISTINCT terms matched (e.g. from
// literalNoteMatchCount called once against a combo's FULL combined note list) — summing this
// per-component instead would double-count a note that happens to appear in two components.
const EXACT_NOTE_COVERAGE_TIERS = [10, 7, 5];
export function exactNoteCoverageScore(distinctMatchCount) {
  let score = 0;
  for (let i = 0; i < distinctMatchCount; i++) {
    score += EXACT_NOTE_COVERAGE_TIERS[Math.min(i, EXACT_NOTE_COVERAGE_TIERS.length - 1)];
  }
  return score;
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

// Every product sharing one identical primary family, with no contrasting role at all — extracted
// as its own helper (not just inlined in the duplicate_direction rule below) so the risk-grouping
// logic further down can ask "which family is duplicated?" directly, instead of parsing it back out
// of the rule's own message string.
function findDuplicatedDirection(products) {
  const directionCounts = {};
  for (const p of products) {
    for (const family of detectFamilies(p.notes, PREFERENCE_FAMILIES)) {
      directionCounts[family] = (directionCounts[family] || 0) + 1;
    }
  }
  const duplicated = Object.entries(directionCounts).find(([, count]) => count === products.length && products.length > 1);
  return duplicated ? duplicated[0] : null;
}

// Fix (single_family_concentration) — the largest pairwise real-note overlap between any two
// products in the combo. A near-DUPLICATE pair (ratio > NEAR_DUPLICATE_OVERLAP_RATIO in
// recommendationEngine.server.js, 0.5) is already hard-rejected long before a combo ever reaches
// risk assessment, so this never sees that case — it exists to catch a MILDER but still notably
// repetitive overlap that survives that harder gate, as its own real-problem signal.
function maxPairwiseNoteOverlap(products) {
  let max = 0;
  for (let i = 0; i < products.length; i++) {
    for (let j = i + 1; j < products.length; j++) {
      const setA = new Set((products[i].notes || []).map((n) => String(n).toLowerCase()));
      const setB = new Set((products[j].notes || []).map((n) => String(n).toLowerCase()));
      if (!setA.size || !setB.size) continue;
      const overlap = [...setA].filter((n) => setB.has(n)).length / Math.min(setA.size, setB.size);
      if (overlap > max) max = overlap;
    }
  }
  return max;
}
const NOTABLE_OVERLAP_RATIO = 0.35;

// Phase 6 risk rules. Each takes the list of products in a proposed combination (each shaped as
// { title, notes: string[] }) and returns a risk message, or null if that risk isn't present.
// Detection is by literal note keywords only — never inferred from a product title or category.
// Fix (flat risk-count penalty replaced with severity) — every rule now also carries a `severity`
// (advisory/low/medium/high/critical) used by assessCombinationRiskDetails below instead of the old
// flat "-10 per risk" penalty. None of the current rules are "critical" (hard reject) — that tier
// exists for a genuinely disqualifying problem, which none of these 8 heuristics rise to; each is a
// real but survivable aesthetic risk, appropriately a penalty rather than an outright rejection.
//
// A rule's check() may return either a bare message string (severity = the rule's own fixed
// `severity` above) OR an object { id, severity, message } to override BOTH per-invocation — used
// by single_family_concentration below, whose real severity depends on customer context, not a
// fixed property of the rule itself.
export const RISK_RULES = [
  {
    id: "excessive_gourmand_heat",
    severity: "medium",
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
    severity: "medium",
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
    severity: "low",
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
    severity: "low",
    check(products) {
      const spicy = products.filter(
        (p) => detectFamilies(p.notes, PREFERENCE_FAMILIES).includes("spicy"),
      );
      return spicy.length >= 2 ? "Multiple spicy products may clash rather than complement" : null;
    },
  },
  {
    id: "citrus_smoke_clash",
    severity: "advisory",
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
    // Advisory — a Quadbrid is a legitimate, sometimes explicitly requested category, and its
    // complexity is already scored separately (complexityPenalty/typeSimplicityScore in
    // recommendationEngine.server.js); this flag would otherwise double-penalize the same size.
    severity: "advisory",
    check(products) {
      return products.length >= 4
        ? "Four products in one blend raises the risk of a muddled, over-complex result"
        : null;
    },
  },
  {
    id: "powdery_overload",
    severity: "medium",
    check(products) {
      const powdery = products.filter((p) => detectFamilies(p.notes, PREFERENCE_FAMILIES).includes("powdery"));
      return powdery.length >= 2
        ? "Multiple powdery orris/iris/violet/heliotrope notes may build into a heavy, cosmetic-powder impression"
        : null;
    },
  },
  {
    id: "duplicate_direction",
    // High — a combination with zero contrasting role anywhere, in a direction the customer never
    // asked for, is genuinely the most structurally broken of these heuristics. Fix (contextual
    // severity) — confirmed live: this used to fire "high" for EVERY customer whose entire stated
    // preference is one single family (e.g. "Fruity, Apple, Strawberry, Peach") — an extremely
    // common, entirely ordinary customer type, not a real defect; of COURSE a combo built to match
    // a single-family preference shares that one family. A direction the customer DID ask for is
    // handled by single_family_concentration below instead, with severity that actually depends on
    // whether it causes a real problem — this rule now only fires for a repeated direction that
    // was NOT requested, which stays exactly as meaningful a risk as before.
    severity: "high",
    check(products, context = {}) {
      const family = findDuplicatedDirection(products);
      if (!family) return null;
      if ((context.likeFamilies || []).includes(family)) return null;
      return `Every product shares the same "${family}" direction with no contrasting role`;
    },
  },
  {
    id: "single_family_concentration",
    // Default/fallback only — check() below always returns its own explicit severity (advisory,
    // low, medium, or high) once it fires at all, per the exact contextual criteria requested:
    // advisory with real role diversity and no conflict, low with limited role diversity but
    // nothing else wrong, medium/high only once the concentration causes an actual problem.
    severity: "advisory",
    check(products, context = {}) {
      const family = findDuplicatedDirection(products);
      if (!family) return null;
      // The customer's OWN stated preference — duplicate_direction above already covers the
      // not-requested case, unchanged, so this rule only ever evaluates the requested one.
      if (!(context.likeFamilies || []).includes(family)) return null;

      const roles = context.roledProducts?.length === products.length ? context.roledProducts : products;
      const distinctRoles = new Set(roles.map((p) => p.role).filter(Boolean));
      const hasRoleDiversity = distinctRoles.size >= 2;

      const noteText = products.flatMap((p) => p.notes || []).join(" | ").toLowerCase();
      const gourmandOverload = ["sugar", "caramel", "marshmallow", "honey"].filter((kw) => noteText.includes(kw)).length >= 2;
      const heavyOverload = products.filter((p) => detectFamilies(p.notes, PREFERENCE_FAMILIES).includes("strongHeavy")).length >= 2;
      const hotWeatherConflict = context.season === "Summer" && (gourmandOverload || heavyOverload);
      const strengthConflict = context.strengthPreference === "light" && heavyOverload;
      const notableOverlap = maxPairwiseNoteOverlap(products) >= NOTABLE_OVERLAP_RATIO;
      const tooComplexForRoleDiversity = products.length >= 4 && !hasRoleDiversity;

      const problems = [
        hotWeatherConflict && "a hot-weather conflict",
        strengthConflict && "more strength than your light-strength preference",
        notableOverlap && "notably overlapping components",
        tooComplexForRoleDiversity && "too much complexity for the role diversity present",
        gourmandOverload && heavyOverload && "excessive sweetness stacked with excessive heaviness",
      ].filter(Boolean);

      if (problems.length) {
        // High only for an actual hot-weather wearability conflict — confirmed live against the
        // real catalog: many legitimately-different same-family products (e.g. fruity fragrances
        // built on a shared common palette of mango/pineapple/guava) routinely land in the
        // 0.35-0.5 overlap band (below the outright near-duplicate hard-reject at 0.5) purely as
        // an ordinary catalog characteristic, not a real defect — so overlap alone must not
        // escalate to high or it blocks auto-confirmation for ordinary customers routinely.
        const severity = hotWeatherConflict ? "high" : "medium";
        return { id: "excessive_direction_stacking", severity, message: `Repeated "${family}" direction (your own stated preference) compounds into a real problem: ${problems.join(", ")}` };
      }
      if (!hasRoleDiversity) {
        return { id: "insufficient_role_diversity", severity: "low", message: `Every product leans "${family}" — your own stated preference — with limited role diversity, though nothing else conflicts` };
      }
      return { id: "single_family_concentration", severity: "advisory", message: `Every product shares your own stated "${family}" preference, with distinct roles and no real conflict` };
    },
  },
];

// A rule's check() result is either a bare message string or a { id, severity, message } override
// (see single_family_concentration's own comment) — this normalizes either shape to the message
// text alone, for callers (like assessCombinationRisks) that only care about the text.
function messageOf(result) {
  return typeof result === "string" ? result : result?.message ?? null;
}

export function assessCombinationRisks(products, context = {}) {
  return RISK_RULES.map((rule) => messageOf(rule.check(products, context))).filter(Boolean);
}

// Fix (flat risk-count penalty replaced with severity, correlated risks grouped) — a Tribrid/
// Quadbrid built from several products in the SAME family mechanically trips both a family-specific
// rule (competing_fruits/spice_conflict/multiple_heavy_components/powdery_overload) AND
// duplicate_direction for that identical family — two rules flagging the same real problem, which
// used to be double-penalized (-10 each, flat). Grouped by a shared correlation key so only the
// single highest-severity hit per real underlying problem counts toward the total penalty; every
// hit still appears in the returned breakdown (with `counted: false` for the suppressed duplicate)
// so nothing is silently hidden.
const RISK_SEVERITY_PENALTY = { advisory: -1, low: -2, medium: -5, high: -10, critical: -10 };
// Exported so callers outside this file (the auto-confirmation gate) can rank a candidate's own
// counted risks by severity without duplicating this ordering.
export const SEVERITY_RANK = { advisory: 0, low: 1, medium: 2, high: 3, critical: 4 };
const FAMILY_SPECIFIC_RISK_FAMILY = {
  multiple_heavy_components: "strongHeavy",
  competing_fruits: "fruity",
  spice_conflict: "spicy",
  powdery_overload: "powdery",
};

/**
 * Pure grouping/penalty function — takes an array of `{ id, message, severity }` hits (already
 * detected by whatever means) and an optional correlation-key function, and returns the penalty
 * total plus a full transparency breakdown. Kept independent of RISK_RULES so it's directly
 * testable with synthetic hits, including a "critical" severity that no real rule currently uses.
 * @param {Array<{id: string, message: string, severity: string}>} hits
 * @param {(hit: object) => string} [correlationKeyFor] - hits sharing the same key are the same
 *   underlying real problem; only the highest-severity one counts toward riskPenalty.
 * @returns {{ breakdown: Array, riskPenalty: number, hasCritical: boolean }}
 */
export function groupAndPenalizeRisks(hits, correlationKeyFor = (hit) => hit.id) {
  const groups = new Map();
  for (const hit of hits) {
    const key = correlationKeyFor(hit);
    const existing = groups.get(key);
    if (!existing || SEVERITY_RANK[hit.severity] > SEVERITY_RANK[existing.severity]) {
      groups.set(key, hit);
    }
  }
  const countedIds = new Set([...groups.values()].map((h) => h.id));
  const breakdown = hits.map((hit) => ({
    id: hit.id,
    message: hit.message,
    severity: hit.severity,
    counted: countedIds.has(hit.id),
    penalty: countedIds.has(hit.id) ? RISK_SEVERITY_PENALTY[hit.severity] : 0,
  }));
  const hasCritical = hits.some((h) => h.severity === "critical");
  const riskPenalty = breakdown.reduce((sum, r) => sum + r.penalty, 0);
  return { breakdown, riskPenalty, hasCritical };
}

// Real-rule version of the pure function above — detects every RISK_RULES hit against a real
// combination, then groups/penalizes them. `hasCritical: true` means the caller should hard-reject
// the whole combination outright rather than use riskPenalty as a mere score deduction.
const DUPLICATED_FAMILY_RISK_IDS = new Set([
  "duplicate_direction", "single_family_concentration", "insufficient_role_diversity", "excessive_direction_stacking",
]);

export function assessCombinationRiskDetails(products, context = {}) {
  const hits = RISK_RULES
    .map((rule) => {
      const result = rule.check(products, context);
      if (!result) return null;
      // Fix (single_family_concentration) — a rule's check() may override its own id/severity per
      // invocation (see that rule's own comment); fall back to the rule's fixed declaration for a
      // plain string result, exactly as before.
      if (typeof result === "object") return { id: result.id || rule.id, message: result.message, severity: result.severity || rule.severity };
      return { id: rule.id, message: result, severity: rule.severity };
    })
    .filter(Boolean);

  const duplicatedFamily = findDuplicatedDirection(products);
  const correlationKeyFor = (hit) => {
    // Fix (single_family_concentration) — duplicate_direction and its three contextual-severity
    // siblings are all fundamentally the SAME underlying observation ("one family dominates this
    // combo"), just resolved to a different id/severity depending on whether it was requested and
    // whether it causes a real problem — they must correlate together (and with the existing
    // family-specific rules below) so a fruity-heavy combo doesn't get penalized twice for what is
    // really one real fact about it.
    if (DUPLICATED_FAMILY_RISK_IDS.has(hit.id)) return duplicatedFamily ? `family:${duplicatedFamily}` : hit.id;
    if (FAMILY_SPECIFIC_RISK_FAMILY[hit.id]) return `family:${FAMILY_SPECIFIC_RISK_FAMILY[hit.id]}`;
    return hit.id;
  };

  return groupAndPenalizeRisks(hits, correlationKeyFor);
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
  // Fix (real customers say "strong scents", not "too strong") — confirmed live: a customer whose
  // ONLY stated dislike was "strong scents" produced zero sensitivity signal (only the narrower
  // "too strong" phrasing was recognized), so a QUADBRID with 40+ combined notes still won despite
  // the customer explicitly saying the opposite of what they wanted.
  /\bstrong\s*(scent|smell|perfume|fragrance|cologne)/i,
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
