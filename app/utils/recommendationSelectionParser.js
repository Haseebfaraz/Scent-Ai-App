// Fix 6 — deterministic resolution of "which recommendation did the customer mean," so the
// backend never asks the model to reconstruct a choice from product names/descriptions. Resolves
// only against the currently active recommendation list for this conversation (passed in as
// `activeList`, in rank order) — never a stale or reconstructed list.
//
// Supports numeric ("1", "2"), written ("one", "two"), ordinal ("first", "second", "last"), common
// selection phrases ("go with", "create this", "I like number 1", "opt 1 is good"), and minor
// spelling mistakes (Levenshtein distance 1 against the phrase's own keywords — e.g. "goof" for
// "good", "optoin" for "option").

const WRITTEN_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, last: -1 };

// Words a customer might use to say "good"/"this one"/"go with" — including a couple of common
// typos seen in real messages ("goof" for "good"). Deliberately a short, explicit list rather than
// a generic spell-checker, since selection phrasing is a small, well-known vocabulary.
const AFFIRMATION_WORDS = new Set(["good", "goof", "fine", "great", "perfect", "yes", "ok", "okay", "this"]);

function levenshtein1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;
  let i = 0, j = 0, mismatches = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    mismatches++;
    if (mismatches > 1) return false;
    if (a.length === b.length) { i++; j++; }
    else if (a.length > b.length) i++;
    else j++;
  }
  return true;
}

function fuzzyIncludes(words, target) {
  return words.some((w) => levenshtein1(w, target));
}

/**
 * @param {string} text - the customer's raw message.
 * @param {Array<{recommendationId: string}>} activeList - the current recommendation list, in rank order.
 * @returns {{ recommendationId: string } | { ambiguous: true } | { noMatch: true }}
 */
export function parseRecommendationSelection(text, activeList) {
  if (!Array.isArray(activeList) || !activeList.length) return { noMatch: true };
  const normalized = (text || "").toLowerCase().trim();
  const words = normalized.split(/[\s,.'"!?-]+/).filter(Boolean);

  // Numeric digit, e.g. "1", "opt 1", "option 1", "number 1".
  const digitMatch = normalized.match(/\b(\d+)\b/);
  let rank = digitMatch ? parseInt(digitMatch[1], 10) : null;

  // Written number ("one", "two") or ordinal ("first", "second", "last").
  if (rank === null) {
    for (const w of words) {
      if (WRITTEN_NUMBERS[w]) { rank = WRITTEN_NUMBERS[w]; break; }
      if (ORDINALS[w] !== undefined) { rank = ORDINALS[w] === -1 ? activeList.length : ORDINALS[w]; break; }
    }
  }

  // No explicit rank found — a bare affirmation ("this one is fine", "create this") with only one
  // active recommendation unambiguously means that one.
  if (rank === null) {
    const hasAffirmation = words.some((w) => AFFIRMATION_WORDS.has(w)) || fuzzyIncludes(words, "good");
    if (hasAffirmation && activeList.length === 1) {
      return { recommendationId: activeList[0].recommendationId };
    }
    return { noMatch: true };
  }

  if (rank < 1 || rank > activeList.length) return { noMatch: true };
  return { recommendationId: activeList[rank - 1].recommendationId };
}
