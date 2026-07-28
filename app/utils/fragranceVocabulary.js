// Fix 2 — a controlled language-variation layer so customer-facing copy doesn't lean on the same
// handful of words ("fresh", "warm", "vibe", "uplifting") every time. The four direction pools
// below are exactly the ones the spec calls for; picking is deterministic (no randomness — see
// pickWords) so the same recommendation always renders the same way, while different
// recommendations in the same batch don't all draw the identical adjective.
export const DIRECTION_VOCABULARY = {
  light_energetic: [
    "crisp", "airy", "bright", "sparkling", "lively", "invigorating",
    "breezy", "clean-cut", "refreshing", "effortless",
  ],
  smooth_professional: [
    "polished", "refined", "composed", "sophisticated", "well-balanced",
    "understated", "professional", "modern", "sleek", "confident",
  ],
  sweet_comforting: [
    "creamy", "soft", "cozy", "indulgent", "playful", "delicious",
    "velvety", "comforting", "gentle", "smoothly sweet",
  ],
  deep_evening: [
    "luxurious", "magnetic", "dramatic", "sensual", "mysterious",
    "full-bodied", "statement-making", "captivating", "intense", "opulent",
  ],
};

// Maps a recommendationEngine role (see app/services/recommendationEngine.server.js assignRoles)
// to the direction pool it draws from — a deliberate, documented judgment call, not a technical
// fact: fresh/fruity roles read as light and energetic, sweetness reads as comforting, a floral
// bridge reads as refined, and base/longevity roles (musk, wood, oud, amber, leather, smoke) read
// as deep and evening-oriented, matching standard perfumery convention that base notes carry
// richness/depth. "Contrast" (no strong detected family) defaults to the neutral, versatile
// smooth/professional pool rather than guessing a stronger direction that isn't actually there.
const DIRECTION_BY_ROLE = {
  Freshness: "light_energetic",
  "Main fruit body": "light_energetic",
  Sweetness: "sweet_comforting",
  "Floral bridge": "smooth_professional",
  "Musk/wood base": "deep_evening",
  "Longevity support": "deep_evening",
  Contrast: "smooth_professional",
};

export function directionForRole(role) {
  return DIRECTION_BY_ROLE[role] || "smooth_professional";
}

// Deterministically picks `count` distinct words from `pool`, starting at an offset derived from
// `seed` (e.g. a componentKey or recommendationId) so the same input always produces the same
// words, but different seeds spread out across the pool instead of all starting at word #1 —
// this is what keeps a whole batch of recommendation cards from all repeating the same adjective.
export function pickWords(pool, count, seed = "", usedWords = new Set()) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;

  const available = pool.filter((w) => !usedWords.has(w));
  const source = available.length >= count ? available : pool;
  const startIndex = source.length ? hash % source.length : 0;

  const picked = [];
  for (let i = 0; i < source.length && picked.length < count; i++) {
    picked.push(source[(startIndex + i) % source.length]);
  }
  picked.forEach((w) => usedWords.add(w));
  return picked;
}

// Builds a short, varied customer-facing character description from a combination's real
// detected roles — never invents a scent quality that isn't backed by an actual assigned role.
// `usedWords` should be threaded across an entire batch of recommendations (one Set per
// generateNewProductCombinations call) so a customer never sees the same adjective twice across
// their 2-3 cards.
export function describeCharacter(roles, seed, usedWords = new Set()) {
  const directions = [...new Set(roles.map(directionForRole))];
  const phrases = directions.map((direction) => {
    const words = pickWords(DIRECTION_VOCABULARY[direction], 2, seed + direction, usedWords);
    return words.join(" and ");
  });
  return phrases.join(", with a ");
}
