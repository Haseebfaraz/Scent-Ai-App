// Phase 9 — the 11 required MCP/AI tools, in the same OpenAI function-calling format the existing
// tools in app/routes/chat.jsx already use (type: "function", function: {name, description,
// parameters}). executeFragranceTool() is the single dispatch point chat.jsx's tool-call loop
// invokes; every handler validates its parsed arguments with Zod before touching a service, and
// every handler talks to real data only — no handler ever invents a product, note, score, or ratio.
import { z } from "zod";
import crypto from "crypto";
import prisma from "../db.server.js";
import {
  emptyProfile,
  getCustomerProfile,
  saveCustomerProfileField,
  saveCustomerProfileFields,
  getMissingRequiredFields,
  isProfileReadyForAnalysis,
  VALID_SEASONS,
  VALID_STRENGTH_PREFERENCES,
} from "../services/customerProfile.server.js";
import { analyzeCustomerProductCandidates } from "../services/orderHistoryAnalysis.server.js";
import { getProductNotesAndCombinationStatus } from "../services/productCatalog.server.js";
import {
  findExistingCombinationsForProduct,
  checkExactCombinationExists,
  findCombinationsUsingSimilarNotes,
} from "../services/combinationAnalysis.server.js";
import { generateNewProductCombinations, validateCombinationShape, CUSTOMER_FIT_LOW_THRESHOLD } from "../services/recommendationEngine.server.js";
import { saveRecommendation, confirmRecommendation } from "../services/recommendationConfirmation.server.js";
import { verifyCity, fetchCurrentWeather } from "../services/locationVerification.server.js";
import { getOilInventoryForProductTitles } from "../services/odooInventory.server.js";
import { buildProductionFormula, computeFeasibility } from "../services/fragranceFormula.server.js";
import {
  describeWeatherSimple, deriveWeatherDirection, weatherDirectionToQuerySeason,
  hasSeasonWeatherConflict, getCalendarSeason,
} from "../utils/weatherSeason.js";
import { parseRecommendationSelection } from "../utils/recommendationSelectionParser.js";
import {
  textToPreferenceFamilies, literalNoteTermsFromLikes, matchedRealNotesInText,
  splitDislikesByExactness, literalNoteMatchCount, SEVERITY_RANK,
} from "../utils/fragranceCompatibility.js";
import { buildPreviewUrl } from "../utils/previewUrl.server.js";
import { correctPreferenceVocabulary, correctPreferenceVocabularyList } from "../utils/fragranceNormalization.js";

// Fix (preference vocabulary normalization) — the profile fields a customer's own free-text
// wording actually flows into; only these get the misspelling corrector applied. requestedSeasonStyle
// is a fixed enum (never free text) and doesn't need it.
const VOCABULARY_CORRECTED_FIELDS = new Set(["likes", "dislikes", "preferredStyle", "occasion", "additionalPreferences"]);

// Fix (profile normalization) — a preferredStyle answer that's actually a non-answer ("you should
// know", "surprise me") carries no real style signal. Deriving a deterministic guess from whatever
// real signal already exists (likes, additional preferences, requested season style) means the
// profile still has something real to generate from, without ever inventing a preference the
// customer never gave — labeled internally as "inferred," never presented to the customer as a
// literal fact they stated.
const NO_REAL_STYLE_PATTERN = /you should know|you decide|surprise me|not sure|no preference|i ?don'?t know|\bidk\b|whatever you (think|want|pick)/i;
const NO_REAL_VALUE_PATTERN = /^(na|n\/a|none|nothing|no)$/i;
// Fix (mood/filler reply saved as a real name) — the prompt already says "if it doesn't look like a
// real name, gently clarify instead of guessing," but that's advisory only — confirmed live, a
// customer's reply to "What should I call you?" ("not having a great day") got saved verbatim as
// their name. A real backend gate instead: reject anything that reads like a mood/sentence rather
// than a name, same pattern as NO_REAL_STYLE_PATTERN above.
// Fix (round 2 — greeting words and generic placeholder nouns accepted as a name) — confirmed live:
// a customer who typed "hello" (an interjection, not a name) then "user" (a generic role noun, not
// a name) had BOTH accepted and saved verbatim. Genuine part-of-speech tagging ("only accept
// nouns") isn't practical here without a full NLP/dictionary dependency this codebase doesn't use
// anywhere else — every other vocabulary check in this file is a deterministic keyword list, so
// this stays consistent with that: a bounded list of the specific common greeting/placeholder words
// people actually type instead of a real name, same pattern as the mood-word list above.
const IMPLAUSIBLE_NAME_PATTERN = /\b(day|today|feeling|doing|tired|busy|great|good|bad|fine|ok|okay|nothing|well|not|having|going|alright|stressed|happy|sad|meh|hello|hi|hey|yo|sup|greetings|user|guest|customer|client|admin|test|testing|anonymous|unknown|nobody|somebody)\b/i;
function isImplausibleName(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return true;
  if (trimmed.split(/\s+/).length > 4) return true;
  return IMPLAUSIBLE_NAME_PATTERN.test(trimmed);
}
function inferStyleFromProfile(profile) {
  const parts = [];
  const likeFamilies = textToPreferenceFamilies(profile.likes || []);
  if (likeFamilies.length) parts.push(likeFamilies.join(" & "));
  if (profile.additionalPreferences?.length) parts.push(profile.additionalPreferences.join(", "));
  if (profile.requestedSeasonStyle) parts.push(`${profile.requestedSeasonStyle}-appropriate`);
  return parts.length ? parts.join(", ") : "Versatile, easy-to-wear";
}

// Ephemeral, query-purposes-only "which historical season bucket to sample" — never shown to the
// customer, never persisted. Prefers an explicit requestedSeasonStyle; otherwise derives one from
// the real weatherDirection already saved on the profile; otherwise falls back to the calendar.
function effectiveQuerySeason(profile) {
  if (profile.requestedSeasonStyle) return profile.requestedSeasonStyle;
  return weatherDirectionToQuerySeason(profile.weatherDirection, getCalendarSeason(profile.country));
}

// Fix 3 — strips every internal field (real source product titles/notes, raw scores/reasons) from
// a freshly-generated in-memory combination before it is ever handed to the model's own narration
// or an SSE customer payload. Mirrors recommendationConfirmation.server.js's
// toCustomerSafeRecommendation, but operates on the in-memory generator output (which already has
// the customerFacing* fields flattened, not nested under customerFacingJson).
function toCustomerSafeCombo(withIdCombo) {
  const {
    recommendationId, type, existsAlready, evidenceScope, confidence, confidenceBreakdown,
    customerFacingName, customerFacingDescription, customerFacingWhySuits,
    customerFacingBestUse, customerFacingWeatherSuitability, customerFacingStrength, customerFacingRisk,
    customerFacingNotesByProduct,
    // Fix (Aniq spec, sections 11-12) — real product names/notes/ratio/evidence are now part of the
    // customer-safe shape (this reverses the earlier hidden-name design per this spec's explicit
    // instruction). Internal database IDs/raw scoring internals still never appear here.
    components, combinedDirection, sharedOrConnectingNotes, whyNotesWork, expectedResult,
    customerFacingHistoricalEvidence, existingCombinationEvidence,
  } = withIdCombo;
  return {
    recommendationId, type, existsAlready, evidenceScope, confidence, confidenceBreakdown,
    customerFacingName, customerFacingDescription, customerFacingWhySuits,
    customerFacingBestUse, customerFacingWeatherSuitability, customerFacingStrength, customerFacingRisk,
    customerFacingNotesByProduct,
    components, combinedDirection, sharedOrConnectingNotes, whyNotesWork, expectedResult,
    customerFacingHistoricalEvidence, existingCombinationEvidence,
  };
}

// Ephemeral, regenerable per-conversation scratch space — NOT the durable CustomerProfileState.
// Holds the last analyze_customer_product_candidates/generate_new_product_combinations results so
// generate_new_product_combinations, refine_combination_recommendations, and
// confirm_product_combination don't require the model to re-transmit a whole scored candidate or
// combination array (which it could only do by retyping/hallucinating the numbers). Lost on server
// restart exactly like chat.jsx's own CONVERSATIONS cache — always safe to regenerate from a fresh
// analyze_customer_product_candidates call.
const conversationScratch = new Map(); // conversationId -> { candidateProducts, lastCombinations, profileHash }

// Fix (Aniq spec, cache invalidation) — every recommendation-relevant profile field, hashed
// deterministically. Confirmed real risk: without this, a customer changing their preferred style
// or dislikes mid-conversation could still get combinations generated from the OLD profile's
// cached candidateProducts, since analyze_customer_product_candidates was only ever re-run when
// scratch.candidateProducts was still null — never when the profile itself had actually changed.
function computeProfileHash(profile) {
  const relevant = {
    city: profile?.city, stateRegion: profile?.stateRegion, country: profile?.country,
    requestedSeasonStyle: profile?.requestedSeasonStyle, weatherDirection: profile?.weatherDirection,
    likes: profile?.likes, dislikes: profile?.dislikes, preferredStyle: profile?.preferredStyle,
    inferredStyle: profile?.inferredStyle, additionalPreferences: profile?.additionalPreferences,
    strengthPreference: profile?.strengthPreference,
    // Fix (lifestyle scoring) — occasion is where interpretLifestyleContext reads its signal from;
    // without this, a customer changing their stated occasion mid-conversation (e.g. adding "I'm
    // usually at the gym") would keep scoring against the OLD, now-stale lifestyle context.
    occasion: profile?.occasion,
  };
  return crypto.createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
}

// Test-only escape hatch (Required Test 8: cache invalidation) — the module otherwise has no way
// to observe whether a cached scratch entry was actually cleared by a profile change.
export function __getScratchForTesting(conversationId) {
  return conversationScratch.get(conversationId);
}

// Required diagnostic logging (auto-preview-flow debugging) — conversation/recommendation/preview
// IDs and event metadata only, never a full customer profile or private customer data.
function logPreviewEvent(stage, { conversationId, recommendationId, previewId, eventType, previewUrl }) {
  console.log(stage, JSON.stringify({ conversationId, recommendationId, previewId, eventType, previewUrl }));
}

// Fix (no confidence gate before auto-confirmation) — confirmed as a real gap: the highest-ranked
// candidate got auto-confirmed regardless of confidence, so a "low" confidence combination could be
// presented to the customer with exactly the same certainty as a "very high" one.
//
// Fix (blocking ALL "low" broke the core auto-preview flow) — confirmed live in testing: under the
// existing confidence formula, "low" is the common outcome for an ordinary customer without deep
// historical evidence (e.g. a fresh profile with just one stated like) — not a rare edge case. A
// blanket block left the primary flow this whole engine is built around failing routinely with "not
// confident enough" instead of ever opening a preview.
//
// Fix (never block on sparse evidence, only a genuinely bad formula) — data/historical/novelty
// confidence are all "how much evidence backs this" — thin evidence alone isn't dangerous, just
// less certain, so none of them (nor the blended `confidence` label, which mixes them in) gate
// auto-confirmation. What DOES block: the formula is a poor match for this customer (customerFit
// "low"), incompatible (compatibility "low" — 2+ real risks), or genuinely risky (a surviving
// high/critical-severity risk).
//
// Fix (persist the gate's own reasoning) — the decision used to be made transiently inside the
// confirm loop with no record of why; there was no way to audit or test a specific ranked
// recommendation's eligibility after the fact. Computes and returns every raw value the gate
// checks, so the caller can attach it to the recommendation before it's ever saved.
//
// hasHardDislikeConflict and shapeValid are independent re-checks, defense in depth exactly like
// saveRecommendation/confirmRecommendation already apply for the same two things — generation-time
// filtering (scoreProposedCombination/validateCombinationShape) already guarantees a ranked
// candidate can't actually have either problem, but the gate never trusts that alone.
// Deterministic — no network call. Odoo manufacturing feasibility is a SEPARATE, later gate
// (evaluateCandidateInventory below), checked only for the candidate currently being considered in
// autoSelectAndConfirmBest's ranked walk, not for every candidate up front. Confirmed live: checking
// every candidate's inventory eagerly here repeated the same Odoo lookups across most of them
// (the same anchor/support product recurs in many candidates) and pushed one generation turn past
// 30s — ranking must finish on real preference/compatibility/risk signals alone, exactly like it did
// before Odoo existed, and only the ranked-but-not-yet-selected winner ever waits on a network call.
function evaluateAutoConfirmEligibility(candidate, profile) {
  const breakdown = candidate.confidenceBreakdown || {};
  const customerFitConfidence = breakdown.customerFit?.value ?? null;
  const compatibilityConfidence = breakdown.compatibility?.value ?? null;

  const countedRisks = (candidate.riskBreakdown || []).filter((r) => r.counted);
  const highestCountedRiskSeverity = countedRisks.reduce(
    (worst, r) => (worst === null || SEVERITY_RANK[r.severity] > SEVERITY_RANK[worst] ? r.severity : worst),
    null,
  );
  const hasHighSeverityRisk = highestCountedRiskSeverity === "high" || highestCountedRiskSeverity === "critical";

  const { exactNoteDislikes } = splitDislikesByExactness(profile?.dislikes || []);
  const allNotes = (candidate.internalProducts || []).flatMap((p) => p.notes || []);
  const hasHardDislikeConflict = literalNoteMatchCount(allNotes, exactNoteDislikes) > 0;

  let shapeValid = true;
  try {
    validateCombinationShape({ type: candidate.type, products: candidate.internalProducts, recommendedRatio: candidate.recommendedRatio });
  } catch {
    shapeValid = false;
  }

  const reasons = [];
  // Hard dislike and invalid shape are checked first and block unconditionally, regardless of how
  // high the final score or how strong the history is — neither is a matter of degree.
  if (hasHardDislikeConflict) reasons.push("hard_dislike_conflict");
  if (!shapeValid) reasons.push("invalid_shape");
  if (hasHighSeverityRisk) reasons.push(`high_severity_risk:${highestCountedRiskSeverity}`);
  if (customerFitConfidence === "low") reasons.push("customer_fit_low");
  if (compatibilityConfidence === "low") reasons.push("compatibility_low");

  return {
    autoConfirmEligible: reasons.length === 0,
    autoConfirmReasons: reasons,
    customerFitThreshold: CUSTOMER_FIT_LOW_THRESHOLD,
    highestCountedRiskSeverity,
    hasHardDislikeConflict,
    shapeValid,
  };
}

// Odoo manufacturing feasibility gate — the FINAL check, only for the one ranked candidate
// currently being considered. Batches this candidate's 2-4 real components into one
// getOilInventoryForProductTitles call (Promise.all under the hood today; swappable for a real
// POST /inventory/batch later without any change here) rather than sequential per-SKU calls.
//
// Fallback/WARN semantics (endpoint not yet verified) — matches the spec's explicit "do not enable
// STRICT until at least one real SKU lookup succeeds": only a CONFIRMED "not enough" answer
// (mappingStatus "CONNECTED" and availableOilMl < requiredOilMl) makes buildable=false. Missing
// mapping / SKU not found / unsupported UoM / lookup failure never reject in this mode — but
// inventoryValidated is false for ALL of those, and a lookup failure specifically is logged as
// ODOO_INVENTORY_LOOKUP_FAILED, distinct from a real validated answer, never presented as if the
// formula had actually been confirmed buildable against real stock.
async function evaluateCandidateInventory(candidate) {
  const startedAt = Date.now();
  try {
    const formula = buildProductionFormula(
      (candidate.recommendedRatio || []).map((r) => ({ productTitle: r.productTitle, ratioPercent: r.ratioPercent })),
    );
    const titles = formula.components.map((c) => c.productTitle);
    const { results, requestCount, skusQueried } = await getOilInventoryForProductTitles(titles);

    const components = formula.components.map((c) => {
      const inventory = results.get(c.productTitle) || { mappingStatus: "MISSING" };
      return {
        productTitle: c.productTitle,
        requiredOilMl: c.requiredOilMl,
        mappingStatus: inventory.mappingStatus,
        availableOilMl: inventory.mappingStatus === "CONNECTED" ? inventory.availableOilMl : null,
      };
    });

    const lookupFailed = components.filter((c) => c.mappingStatus === "LOOKUP_FAILED");
    if (lookupFailed.length) {
      console.log("ODOO_INVENTORY_LOOKUP_FAILED", {
        recommendationId: candidate.recommendationId,
        components: lookupFailed.map((c) => ({ productTitle: c.productTitle })),
      });
    }

    const knownComponents = components.filter((c) => c.mappingStatus === "CONNECTED");
    const confirmedInsufficient = knownComponents.length > 0 && !computeFeasibility(knownComponents).buildable;
    const inventoryValidated = knownComponents.length === components.length && components.length > 0;

    return {
      buildable: !confirmedInsufficient,
      inventoryValidated,
      components,
      requestCount,
      skusQueried,
      durationMs: Date.now() - startedAt,
    };
  } catch {
    // Malformed ratios are already caught by shapeValid in evaluateAutoConfirmEligibility — never
    // let a formula-building error here reject a candidate for the wrong reason.
    return { buildable: true, inventoryValidated: false, components: [], requestCount: 0, skusQueried: [], durationMs: Date.now() - startedAt };
  }
}

// Fix (auto-preview flow) — the ONE place that turns a freshly generated/refined combination list
// into an automatically-opened preview. Used by both generate_new_product_combinations AND
// refine_combination_recommendations — a customer who says "make it sweeter" or "remove the dark
// chocolate" after Recreate must land on an auto-opened preview exactly the same way a first-time
// generation does, never back on a "pick one of N" list. `withIds` must already be rank-sorted
// best-first (both generateNewProductCombinations call sites are). Walking it in order and
// confirming the first one that actually re-verifies AND clears the confidence gate above is "the
// highest-ranked VALID, sufficiently-confident recommendation" — a rare re-verification failure
// (e.g. a component vanished from the catalog microseconds after generation) or a too-low-confidence
// candidate falls through to the next-best real candidate instead of silently failing the turn or
// opening a preview the engine itself isn't confident in.
async function autoSelectAndConfirmBest(withIds, conversationId, context) {
  const turnStartedAt = Date.now();
  logPreviewEvent("RECOMMENDATIONS_RANKED", {
    conversationId, recommendationId: null, previewId: null, eventType: "generate_new_product_combinations", previewUrl: null,
  });

  // Fix (30s+ generation turns) — Odoo used to be checked for EVERY ranked candidate before this
  // loop even started; the same anchor/support product recurs across most candidates, so that
  // repeated the identical lookup many times over. Odoo is now the FINAL gate, checked only for the
  // one candidate currently under consideration, and only once the cheap deterministic checks
  // (customer fit/risk/shape/dislike — already computed synchronously on every candidate) pass —
  // ranking itself never waits on a network call, exactly as it didn't before Odoo existed.
  let anyConfidenceGated = false;
  let anyInventoryRejected = false;
  let candidatesInventoryChecked = 0;
  let odooRequestCount = 0;
  let odooDurationMs = 0;
  const skusQueriedSet = new Set();

  for (const candidate of withIds) {
    if (!candidate.autoConfirmEligible) { anyConfidenceGated = true; continue; }

    candidatesInventoryChecked += 1;
    const inventory = await evaluateCandidateInventory(candidate);
    odooRequestCount += inventory.requestCount;
    odooDurationMs += inventory.durationMs;
    inventory.skusQueried.forEach((sku) => skusQueriedSet.add(sku));
    if (!inventory.buildable) {
      anyInventoryRejected = true;
      console.log("FORMULA_INVENTORY_REJECTED", { conversationId, recommendationId: candidate.recommendationId });
      continue;
    }
    console.log("FORMULA_INVENTORY_BUILDABLE", { conversationId, recommendationId: candidate.recommendationId, inventoryValidated: inventory.inventoryValidated });

    const confirmResult = await confirmRecommendation({
      recommendationId: candidate.recommendationId,
      customerName: context.customerName,
      customerEmail: context.customerEmail,
    });
    if (!confirmResult.ok) continue;

    await saveCustomerProfileFields(conversationId, { selectedRecommendationId: candidate.recommendationId });
    const previewUrl = await buildPreviewUrl(candidate.recommendationId);
    logPreviewEvent("BEST_RECOMMENDATION_SELECTED", {
      conversationId, recommendationId: candidate.recommendationId, previewId: candidate.recommendationId,
      eventType: "preview_ready", previewUrl,
    });
    logPreviewEvent("PREVIEW_READY_EMITTED", {
      conversationId, recommendationId: candidate.recommendationId, previewId: candidate.recommendationId,
      eventType: "preview_ready", previewUrl,
    });
    console.log("BEST_BUILDABLE_RECOMMENDATION_SELECTED", {
      rankedCandidateCount: withIds.length, candidatesChecked: candidatesInventoryChecked,
      odooRequestCount, skusQueriedCount: skusQueriedSet.size, odooDurationMs, totalDurationMs: Date.now() - turnStartedAt,
    });
    return {
      ok: true,
      modelContent: `The best recommendation (recommendationId ${candidate.recommendationId}) was selected and confirmed automatically. The preview page is opening on its own right now — do NOT list any combinations, do NOT ask the customer to pick one, do NOT ask "how do these sound", and do NOT say anything further about this turn.`,
      sseEvent: { type: "preview_ready", recommendationId: candidate.recommendationId, previewId: candidate.recommendationId, previewUrl },
    };
  }

  console.log("ODOO_INVENTORY_PERFORMANCE_SUMMARY", {
    rankedCandidateCount: withIds.length, candidatesChecked: candidatesInventoryChecked,
    odooRequestCount, skusQueriedCount: skusQueriedSet.size, odooDurationMs, totalDurationMs: Date.now() - turnStartedAt,
  });

  // Fix (no confidence gate before auto-confirmation) — every candidate that was otherwise valid
  // got filtered out purely for being too low-confidence to present with certainty; tell the model
  // the truth so it can ask for more detail or offer to try again, instead of a generic "technical
  // issue" excuse that misdescribes what actually happened.
  if (anyConfidenceGated) {
    return {
      ok: false,
      modelContent: "every generated combination was too low-confidence to recommend with certainty (thin evidence, weak fit to what the customer said, or a real compatibility risk) — tell the customer honestly that nothing felt like a confident enough match yet, and ask a bit more about their preferences rather than presenting a weak guess as a solid recommendation.",
    };
  }
  if (anyInventoryRejected) {
    return {
      ok: false,
      modelContent: "every generated combination that otherwise fit the customer well couldn't be confirmed as buildable from current inventory — tell the customer honestly that we need a moment to find an available option, and offer to try again shortly.",
    };
  }
  // Every ranked candidate failed re-verification (rare) — never silently open a broken preview;
  // tell the model plainly instead so it can inform the customer honestly.
  return {
    ok: false,
    modelContent: "every generated combination failed re-verification (catalog changed, ratio drift, or a dislike conflict) — tell the customer there was a temporary issue preparing their fragrance and ask if they'd like to try again.",
  };
}

/**
 * @param {string} conversationId
 * @param {object} [profile] - when given, clears cached candidateProducts/lastCombinations if the
 *   profile has changed since the last call that supplied one.
 */
function getScratch(conversationId, profile) {
  if (!conversationScratch.has(conversationId)) {
    conversationScratch.set(conversationId, { candidateProducts: null, lastCombinations: null, profileHash: null });
  }
  const scratch = conversationScratch.get(conversationId);
  if (profile) {
    const hash = computeProfileHash(profile);
    if (scratch.profileHash && scratch.profileHash !== hash) {
      scratch.candidateProducts = null;
      scratch.lastCombinations = null;
    }
    scratch.profileHash = hash;
  }
  return scratch;
}

// ============================================================
// Zod schemas (runtime validation of parsed tool-call arguments)
// ============================================================
const PROFILE_FIELD_SCHEMAS = {
  name: z.string().min(1).max(200),
  email: z.string().email(),
  city: z.string().min(1).max(200),
  stateRegion: z.string().min(1).max(200),
  country: z.string().min(1).max(200),
  requestedSeasonStyle: z.enum(VALID_SEASONS),
  likes: z.array(z.string().min(1)).max(20),
  dislikes: z.array(z.string().min(1)).max(20),
  preferredStyle: z.string().min(1).max(200),
  occasion: z.string().min(1).max(200),
  giftRecipient: z.string().min(1).max(200),
  // Fix (ask about dislikes/occasion before analysis) — booleans, not text, so this is the only
  // pair of fields that needs the value union below extended to accept z.boolean() too.
  dislikesAsked: z.boolean(),
  occasionAsked: z.boolean(),
  strengthPreference: z.enum(VALID_STRENGTH_PREFERENCES),
  additionalPreferences: z.array(z.string().min(1)).max(20),
};
const PROFILE_FIELD_NAMES = Object.keys(PROFILE_FIELD_SCHEMAS);

const SaveProfileFieldArgs = z.object({
  field: z.enum(PROFILE_FIELD_NAMES),
  value: z.union([z.string(), z.array(z.string()), z.boolean()]),
});
const ProductTitleArgs = z.object({ productTitle: z.string().min(1) });
const CombinationExistsArgs = z.object({ productTitles: z.array(z.string().min(1)).min(2).max(4) });
const SimilarNotesArgs = z.object({ productTitle: z.string().min(1), limit: z.number().int().min(1).max(10).optional() });
const GenerateCombinationsArgs = z.object({
  maximumResults: z.number().int().min(1).max(20).optional(),
  allowedTypes: z.array(z.enum(["HYBRID", "TRIBRID", "QUADBRID"])).min(1).max(3).optional(),
});
const RefineArgs = z.object({ feedback: z.string().min(1) });
const RecommendationIdArgs = z.object({ recommendationId: z.string().min(1) });
const VerifyLocationArgs = z.object({ cityText: z.string().min(1).max(200) });
const ResolveSeasonArgs = z.object({ choice: z.enum(["keep_style", "use_weather"]) });
const SelectRecommendationArgs = z.object({ selectionText: z.string().min(1).max(200) });

// ============================================================
// Tool definitions (OpenAI function-calling format)
// ============================================================
export const FRAGRANCE_AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "save_customer_profile_field",
      description: "Save one field of the customer's structured fragrance profile (name, email, city, stateRegion, country, requestedSeasonStyle, likes, dislikes, preferredStyle, occasion, giftRecipient, dislikesAsked, occasionAsked, strengthPreference, additionalPreferences). Call this every time the customer gives you a real answer for one of these — never track profile progress in your own memory. requestedSeasonStyle is ONLY for when the customer volunteers a specific seasonal style unprompted (e.g. 'I want something wintery') — never ask them what season it is or what season they associate with an occasion; live weather is handled automatically once their city is verified. giftRecipient is ONLY set when the customer indicates this is a gift for someone else (e.g. 'husband', 'wife', 'friend') — once set, likes/dislikes/preferredStyle/occasion describe that recipient, not necessarily the person chatting. dislikesAsked/occasionAsked are booleans (true/false) — set to true the moment you've asked about dislikes/occasion (or already knew the answer from earlier context), regardless of whether the real answer was 'none'/'nothing specific' — an empty dislikes list or a null occasion is ambiguous between 'never asked' and 'asked, real answer was none', these flags disambiguate it.",
      parameters: {
        type: "object",
        properties: {
          field: { type: "string", enum: PROFILE_FIELD_NAMES, description: "Which profile field to set." },
          value: {
            description: "The value for this field. A plain string for most fields; an array of strings for likes/dislikes/additionalPreferences; a boolean (true/false) for dislikesAsked/occasionAsked.",
          },
        },
        required: ["field", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_customer_profile",
      description: "Get the customer's current structured fragrance profile and which required fields (city, country, likes-or-preferredStyle) are still missing before analysis can run.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_customer_product_candidates",
      description: "Deterministically score real DUA products against the customer's current profile using real order-history evidence (region, season/weather direction, likes/dislikes, repeat-purchase and popularity signals). Returns up to 10 real ProductCandidate results. Requires city (verified), country, and at least one like or preferredStyle to already be saved on the profile.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_product_notes_and_combination_status",
      description: "Look up a real DUA product's exact notes, fragrance family, collection, and whether it's a single inspiration, an existing Hybrid/Tribrid/Quadbrid, or a component inside other existing combinations. Never infers notes from a title — only returns what's actually stored.",
      parameters: {
        type: "object",
        properties: { productTitle: { type: "string", description: "Exact or approximate real DUA product title." } },
        required: ["productTitle"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_existing_combinations_for_product",
      description: "Find every existing Hybrid/Tribrid/Quadbrid that either IS this product, or that USES this product as a component.",
      parameters: {
        type: "object",
        properties: { productTitle: { type: "string", description: "Exact or approximate real DUA product title." } },
        required: ["productTitle"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_exact_combination_exists",
      description: "Check whether a specific set of products already exists as an exact Hybrid/Tribrid/Quadbrid, regardless of the order given. Use this before proposing any new combination as 'new'.",
      parameters: {
        type: "object",
        properties: {
          productTitles: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 4,
            description: "The real DUA product titles making up the combination to check.",
          },
        },
        required: ["productTitles"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_combinations_using_similar_notes",
      description: "Find existing combinations whose component products share real notes with the given product — useful evidence for 'combinations built from similar materials to this one'.",
      parameters: {
        type: "object",
        properties: {
          productTitle: { type: "string", description: "Exact or approximate real DUA product title." },
          limit: { type: "number", description: "Max results, default 5." },
        },
        required: ["productTitle"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verify_customer_location",
      description: "Verify a city the customer typed against real order-history data and real geocoding — NEVER accept a city as real just because it sounds plausible (e.g. a fictional place). Call this before saving city/country to the profile. If needsClarification is true, ask the customer which real place they mean from the candidates. If verified is false, tell the customer you couldn't confidently match that location and ask for a real city. On success, this AUTOMATICALLY fetches real live weather and derives a weatherDirection internally too — you never need a separate step for that, and you must never ask the customer what season it is or explain that you're adjusting anything 'accordingly'. If the response says a style conflict needs confirming, ask the customer that ONE brief question before moving on; otherwise just continue naturally (e.g. into preferences/dislikes).",
      parameters: {
        type: "object",
        properties: { cityText: { type: "string", description: "The raw city text the customer gave." } },
        required: ["cityText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resolve_season_preference",
      description: "Call this exactly once, only when a requestedSeasonStyle genuinely conflicted with the real weatherDirection and you've asked the customer which they want. choice='keep_style' keeps their requested style as the basis (e.g. 'a deeper winter-style character' even though it's warm out); choice='use_weather' bases it on today's real conditions instead, clearing the requested style. Never call this again once already resolved for this conversation.",
      parameters: {
        type: "object",
        properties: { choice: { type: "string", enum: ["keep_style", "use_weather"], description: "Which direction the customer picked." } },
        required: ["choice"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "select_recommendation",
      description: "LEGACY/manual path only — generate_new_product_combinations now auto-selects and auto-confirms the best recommendation on its own, so you should not normally need this. Use it only if a customer is looking at an older message that actually listed multiple numbered combinations and picks one by number/phrase ('option 1', 'the first one', 'number 2'). Pass their message text through as-is — never try to figure out the recommendationId yourself from the product description.",
      parameters: {
        type: "object",
        properties: { selectionText: { type: "string", description: "The customer's own selection message, verbatim." } },
        required: ["selectionText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_new_product_combinations",
      description: "Generate genuinely new Hybrid/Tribrid/Quadbrid combination proposals — built from the customer's top real product candidates plus compatible real supporting products — scored on preference match, seasonal fit, historical evidence, note compatibility, balance, and risk. NEVER proposes a combination that already exists. Call analyze_customer_product_candidates first in this conversation if you haven't yet. IMPORTANT: this tool automatically selects and confirms the single best-ranked recommendation for you and opens the fragrance preview page on its own (a preview_ready event) — it does NOT return a list for the customer to pick from. After calling this, do not list combinations, do not ask the customer to choose one, do not ask how they sound — just stop; the preview is already opening.",
      parameters: {
        type: "object",
        properties: {
          maximumResults: { type: "number", description: "Default 8." },
          allowedTypes: {
            type: "array",
            items: { type: "string", enum: ["HYBRID", "TRIBRID", "QUADBRID"] },
            description: "Restrict to specific combination types, e.g. if the customer asks for 'a Hybrid only'.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "refine_combination_recommendations",
      description: "Re-generate combinations based on the customer's feedback (e.g. 'make it sweeter', 'remove the dark chocolate', 'give me a Hybrid only') — used after Recreate asks 'What would you like to change?', or any other time the customer wants an existing recommendation adjusted. Just like generate_new_product_combinations, this automatically selects and confirms the best refined result and opens the fragrance preview page on its own — it does NOT return a list for the customer to pick from. After calling this, do not list combinations, do not ask the customer to choose one — just stop; the preview is already opening.",
      parameters: {
        type: "object",
        properties: { feedback: { type: "string", description: "The customer's own refinement request, verbatim or closely paraphrased." } },
        required: ["feedback"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_product_combination",
      description: "LEGACY/manual path only — generate_new_product_combinations now auto-confirms the best recommendation on its own, so you should not normally need this. Use it only after select_recommendation resolved a customer's manual pick on an older conversation. Deterministically re-verifies everything (products still exist, notes exist, combination is still genuinely new, ratios sum to 100%, no high-severity dislike conflict). This does NOT create a Shopify product — it opens the fragrance preview page instead, where the customer can adjust it and explicitly choose to save or buy — never tell the customer a product has been created at this point.",
      parameters: {
        type: "object",
        properties: { recommendationId: { type: "string", description: "The exact recommendationId of the one specific combination the customer confirmed." } },
        required: ["recommendationId"],
      },
    },
  },
];

// ============================================================
// Refinement feedback -> profile/type adjustments (Phase 8's refinement examples)
// ============================================================
const REFINEMENT_TYPE_KEYWORDS = [
  { pattern: /\bhybrid\b/i, types: ["HYBRID"] },
  { pattern: /\btribrid\b/i, types: ["TRIBRID"] },
  { pattern: /\bquadbrid\b/i, types: ["QUADBRID"] },
];
// Fix (Recreate refinement no-op bug) — every family a customer might plausibly ask for MORE or
// LESS of, in one place, matched with word-form awareness (plain/comparative/adjective forms), then
// combined with NEGATION_PATTERN below to decide direction. Previously likes and dislikes were two
// separate hand-maintained lists — dislikes only ever covered "spicy"/"strong" via a few fixed
// literal phrases ("remove spicy", "less strong", ...) — so a real request like "less woody" or "no
// musk" matched nothing on either list, the "adjusted" profile ended up identical to the original,
// and refine_combination_recommendations silently regenerated the exact same combination (confirmed
// live: same notes, new id/name, after a real refinement request). One list checked for both
// directions fixes that, and also fixes a real bug where "less sweet" used to add sweet as a LIKE —
// there was no negation check anywhere before.
const REFINEMENT_FAMILY_KEYWORDS = [
  { pattern: /\bfresh(er)?\b/i, family: "Fresh" },
  { pattern: /\bsweet(er)?\b/i, family: "Sweet" },
  { pattern: /\bfruit(y|ier)?\b/i, family: "Fruity" },
  { pattern: /\bspic(y|ier|e)?\b/i, family: "Spicy" },
  { pattern: /\bwood(y|ier)?\b/i, family: "Woody" },
  { pattern: /\bmusk(y)?\b/i, family: "Musk" },
  { pattern: /\bpowder(y|ier)?\b/i, family: "Powdery" },
  { pattern: /\b(strong(er)?|heav(y|ier))\b/i, family: "Strong" },
];
const NEGATION_PATTERN = /\b(no|not|don'?t|without|remove|less|avoid|take out|excluding|get rid of)\b/i;
// Fix (sticky negation across a list) — "remove patchouli, vanilla, sandalwood" only carries the
// negation word "remove" in its first clause; treating each comma-split clause as independently
// negated (the previous version) meant only the FIRST named item ever became a dislike — confirmed
// live, repeated refine requests naming several specific notes never actually removed any but the
// first. Polarity now carries forward across clauses in the same message until an explicit positive
// signal flips it back — how a customer naturally lists several unwanted things in one sentence.
const POSITIVE_OVERRIDE_PATTERN = /\b(more|want|add|keep|prefer|love|like)\b/i;
const ONLY_NEW_PATTERN = /\bonly new\b|\bnew combinations? only\b/i;

// Fix (refinement could only recognize notes already in the curated PREFERENCE_FAMILIES vocabulary)
// — confirmed live: "dont want coconut" was a silent no-op until "coconut" was hand-added to a
// family list, and the same gap will recur for the next real catalog note a customer names that
// isn't in the vocabulary yet — there are hundreds of real notes, this file will never enumerate
// them all. `currentNotes` (the real notes of the recommendation actually on screen when the
// customer typed this, passed in by the caller) lets ANY note they can see and name be recognized
// directly via matchedRealNotesInText, not just pre-approved ones — see that function's own comment.
function deriveRefinementAdjustments(feedback, currentNotes = []) {
  // Split into clauses so "less woody, more fruity" resolves each family against ITS OWN clause's
  // polarity, not the sentence as a whole.
  const clauses = feedback.split(/[,;]|\band\b|\bbut\b/i).map((c) => c.trim()).filter(Boolean);
  const addLikes = new Set();
  const addDislikes = new Set();
  // Fix (refinement feedback never updated the stored profile) — addLikes/addDislikes above are
  // FAMILY keys (e.g. "woody"), used only as a one-off regeneration bias — a refinement request
  // never actually persisted anything to the customer's real likes/dislikes fields, so "I don't
  // want sandalwood" never showed up on their profile even though it plainly is one. These parallel
  // sets capture what to persist instead: the literal note the customer actually named per clause
  // when there is one (e.g. "sandalwood"), same shape save_customer_profile_field already uses
  // elsewhere — falling back to the matched family label only when the clause was a pure style word
  // with no specific note ("less woody" -> "woody").
  const addLikeTerms = new Set();
  const addDislikeTerms = new Set();
  let polarity = "like";
  for (const clause of clauses.length ? clauses : [feedback]) {
    if (NEGATION_PATTERN.test(clause)) polarity = "dislike";
    else if (POSITIVE_OVERRIDE_PATTERN.test(clause)) polarity = "like";
    const target = polarity === "dislike" ? addDislikes : addLikes;
    const targetTerms = polarity === "dislike" ? addDislikeTerms : addLikeTerms;

    const clauseFamilies = new Set();
    for (const { pattern, family } of REFINEMENT_FAMILY_KEYWORDS) {
      if (pattern.test(clause)) { target.add(family); clauseFamilies.add(family); }
    }
    // Fix (literal note names not recognized) — REFINEMENT_FAMILY_KEYWORDS above only covers
    // generic descriptor words (sweet/woody/spicy...); a customer naming actual notes ("remove
    // patchouli, vanilla, sandalwood") matched nothing at all before, since those literal note
    // names only live in PREFERENCE_FAMILIES' own keyword lists — confirmed live. Reuses
    // textToPreferenceFamilies exactly as the rest of this file already does, instead of a
    // separate, narrower duplicate.
    for (const family of textToPreferenceFamilies([clause])) { target.add(family); clauseFamilies.add(family); }

    const literalTerms = new Set(literalNoteTermsFromLikes([clause]));
    matchedRealNotesInText(clause, currentNotes).forEach((t) => literalTerms.add(t));
    if (literalTerms.size) literalTerms.forEach((t) => targetTerms.add(t));
    else clauseFamilies.forEach((f) => targetTerms.add(f));
  }
  // A stated exclusion wins over an incidental positive mention of the same family elsewhere in
  // the same message.
  addDislikes.forEach((f) => addLikes.delete(f));
  addDislikeTerms.forEach((t) => addLikeTerms.delete(t));

  const typeMatch = REFINEMENT_TYPE_KEYWORDS.find((k) => k.pattern.test(feedback));
  return {
    addLikes: [...addLikes],
    addDislikes: [...addDislikes],
    addLikeTerms: [...addLikeTerms],
    addDislikeTerms: [...addDislikeTerms],
    allowedTypes: typeMatch ? typeMatch.types : undefined,
    onlyNew: ONLY_NEW_PATTERN.test(feedback), // always true anyway — this engine never proposes existing combos
  };
}

// Test-only escape hatch, same pattern as __getScratchForTesting above — lets the regression suite
// check like/dislike direction deterministically without going through a full tool call.
export function __deriveRefinementAdjustmentsForTesting(feedback, currentNotes) {
  return deriveRefinementAdjustments(feedback, currentNotes);
}

// Test-only escape hatch, same pattern as above — lets the regression suite check the
// auto-confirmation gate's full decision (eligibility, reasons, and every raw value it used)
// directly with a synthetic candidate/profile, without needing a real generation to happen to
// produce one of each case.
export function __evaluateAutoConfirmEligibilityForTesting(candidate, profile) {
  return evaluateAutoConfirmEligibility(candidate, profile);
}

// Test-only escape hatch — lets the regression suite check the Odoo manufacturing feasibility gate
// (the final, separate check) directly with a synthetic candidate, without needing a real
// generation/ranking pass first.
export function __evaluateCandidateInventoryForTesting(candidate) {
  return evaluateCandidateInventory(candidate);
}

// ============================================================
// Dispatch
// ============================================================
/**
 * @param {string} toolName
 * @param {string} rawArgsJson - the tool call's raw JSON argument string.
 * @param {object} context - { conversationId, customerName, customerEmail }.
 * @returns {Promise<{modelContent: string, sseEvent: object|null}>}
 *   Fix (fragrance preview page) — Shopify product creation is no longer triggered from chat at
 *   all; confirm_product_combination's sseEvent (type: "preview_ready") is what the frontend uses
 *   to navigate to the preview page, where creation actually happens (Save Build/Add to Cart).
 */
export async function executeFragranceTool(toolName, rawArgsJson, context) {
  const { conversationId } = context;
  const fail = (message) => ({ modelContent: `Error: ${message}`, sseEvent: null });
  const ok = (modelContent, sseEvent = null) => ({ modelContent, sseEvent });

  let args;
  try {
    args = rawArgsJson ? JSON.parse(rawArgsJson) : {};
  } catch (e) {
    return fail(`couldn't parse arguments as JSON — call ${toolName} again with valid JSON.`);
  }

  try {
    switch (toolName) {
      case "save_customer_profile_field": {
        const parsed = SaveProfileFieldArgs.safeParse(args);
        if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
        // Fix 5 — a trusted identity (authenticated Shopify account, or already saved on the
        // profile) can never be overwritten by a model-supplied value — the model doesn't get to
        // "correct" what the backend already knows to be true.
        if (parsed.data.field === "name" && context.customerName) {
          return ok(`Name is already known and trusted (${context.customerName}) — no need to save or ask again.`);
        }
        if (parsed.data.field === "email" && context.customerEmail) {
          return ok(`Email is already known and trusted — no need to save or ask again.`);
        }
        if (parsed.data.field === "name" && typeof parsed.data.value === "string" && isImplausibleName(parsed.data.value)) {
          return fail(`"${parsed.data.value}" doesn't read like a real name — do not save it. They likely answered a different question, or their reply got misread as an answer to "what should I call you?" Gently ask for their name again instead of guessing.`);
        }

        // Fix (preference vocabulary normalization) — a controlled, whole-word misspelling
        // corrector for the fragrance-vocabulary terms this engine actually matches against
        // (PREFERENCE_FAMILIES/COMPATIBILITY_TAGS), applied only to the free-text profile fields a
        // customer's own wording flows into, BEFORE the NA-filter/non-answer-style checks below so
        // those see corrected text too. Deliberately not unrestricted fuzzy correction — see
        // PREFERENCE_VOCABULARY_CORRECTIONS's own comment. Every correction is recorded, never
        // silently applied with no trace.
        let vocabularyCorrections = [];
        if (VOCABULARY_CORRECTED_FIELDS.has(parsed.data.field)) {
          if (Array.isArray(parsed.data.value)) {
            const result = correctPreferenceVocabularyList(parsed.data.value);
            parsed.data.value = result.corrected;
            vocabularyCorrections = result.corrections;
          } else if (typeof parsed.data.value === "string") {
            const result = correctPreferenceVocabulary(parsed.data.value);
            parsed.data.value = result.corrected;
            vocabularyCorrections = result.corrections;
          }
        }

        // Fix (profile normalization) — "NA"/"none"/"nothing" under dislikes means no stated
        // dislikes, not a literal disliked note called "NA".
        if (parsed.data.field === "dislikes" && Array.isArray(parsed.data.value)) {
          parsed.data.value = parsed.data.value.filter((v) => !NO_REAL_VALUE_PATTERN.test(String(v).trim()));
        }

        // Fix (profile normalization) — a non-answer style ("you should know") never gets stored
        // as a literal preferredStyle; instead derive+save inferredStyle from whatever real signal
        // already exists, so the required-field check reflects real information, not a placeholder.
        if (parsed.data.field === "preferredStyle" && typeof parsed.data.value === "string" && NO_REAL_STYLE_PATTERN.test(parsed.data.value)) {
          const current = await getCustomerProfile(conversationId);
          const inferred = inferStyleFromProfile(current);
          const profile = await saveCustomerProfileFields(conversationId, { inferredStyle: inferred });
          const missing = getMissingRequiredFields(profile);
          return ok(
            `The customer didn't give a real style preference — inferred "${inferred}" from their other stated signals and saved it as inferredStyle (not a literal quote from them). Missing required fields: ${missing.length ? missing.join(", ") : "none — ready to analyze."}`,
            { type: "profile_progress", profile, missingFields: missing },
          );
        }

        const fieldSchema = PROFILE_FIELD_SCHEMAS[parsed.data.field];
        const valueParsed = fieldSchema.safeParse(parsed.data.value);
        if (!valueParsed.success) {
          return fail(`invalid value for field "${parsed.data.field}": ${valueParsed.error.issues.map((i) => i.message).join("; ")}`);
        }
        const fieldsToSave = { [parsed.data.field]: valueParsed.data };
        if (vocabularyCorrections.length) {
          const currentProfile = await getCustomerProfile(conversationId);
          fieldsToSave.preferenceVocabularyCorrections = [
            ...(currentProfile.preferenceVocabularyCorrections || []),
            ...vocabularyCorrections.map((c) => ({ field: parsed.data.field, ...c })),
          ];
        }
        const profile = await saveCustomerProfileFields(conversationId, fieldsToSave);
        const missing = getMissingRequiredFields(profile);

        // Only discuss season when the customer volunteers a style — check for a genuine conflict
        // with the REAL weatherDirection right here, once, rather than leaving it to the model to
        // remember to check.
        if (parsed.data.field === "requestedSeasonStyle") {
          const conflict = hasSeasonWeatherConflict(profile.requestedSeasonStyle, profile.weatherDirection) && !profile.seasonStyleConflictResolved;
          return ok(
            `Saved. Missing required fields before analysis: ${missing.length ? missing.join(", ") : "none — ready to analyze."}` +
              (conflict
                ? ` Real weather today is "${profile.weatherDirection}", which conflicts with the requested ${profile.requestedSeasonStyle} style — briefly ask the customer ONCE whether to keep that style anyway or base it on today's real conditions, then call resolve_season_preference with their answer. Do not present this as a rigid either/or menu — a light check-in, e.g. "It's mild and sunny in ${profile.city || "your city"} today, but I can still shape it with a deeper ${profile.requestedSeasonStyle.toLowerCase()}-style character. Should I keep that direction?"`
                : ` No real conflict with today's weather — do not mention season at all, just continue naturally.`),
            { type: "profile_progress", profile, missingFields: missing },
          );
        }

        return ok(
          `Saved. Missing required fields before analysis: ${missing.length ? missing.join(", ") : "none — ready to analyze."}`,
          { type: "profile_progress", profile, missingFields: missing },
        );
      }

      case "get_customer_profile": {
        const profile = await getCustomerProfile(conversationId);
        return ok(
          `Current profile: ${JSON.stringify(profile)}\nMissing required fields: ${getMissingRequiredFields(profile).join(", ") || "none"}.`,
        );
      }

      case "verify_customer_location": {
        const parsed = VerifyLocationArgs.safeParse(args);
        if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
        const result = await verifyCity(parsed.data.cityText);
        if (result.needsClarification) {
          return ok(`Multiple real places match "${parsed.data.cityText}": ${JSON.stringify(result.candidates)}. Ask the customer which one they mean.`);
        }
        if (!result.verified) {
          return ok(`I couldn't confidently match that location. Which real city are you currently in?`);
        }
        const priorProfile = await getCustomerProfile(conversationId);
        const fields = {
          city: result.city,
          country: result.country || priorProfile.country,
          locationVerified: true,
          locationSource: result.source,
        };

        // Automatic, silent weather fetch + direction derivation the moment the city is verified
        // — never a separate model-driven step, never surfaced as a question. A fetch failure just
        // means weatherDirection stays null; it never blocks verification itself.
        let conflictMessage = "";
        const weather = await fetchCurrentWeather(result.city);
        if (weather) {
          const { summary } = describeWeatherSimple(weather.tempF, weather.weatherCode);
          const direction = deriveWeatherDirection(weather.tempF, weather.weatherCode, weather.relativeHumidityPercent);
          fields.currentWeather = {
            condition: summary,
            temperatureC: Math.round(((weather.tempF - 32) * 5) / 9),
            fetchedAt: new Date().toISOString(),
          };
          fields.weatherDirection = direction;
          fields.weatherLocation = { city: result.city, country: fields.country, verified: true };

          // Rare ordering (style requested before city) — check immediately so it's never missed.
          if (priorProfile.requestedSeasonStyle && !priorProfile.seasonStyleConflictResolved && hasSeasonWeatherConflict(priorProfile.requestedSeasonStyle, direction)) {
            conflictMessage = ` Real weather in ${result.city} is "${direction}", which conflicts with the previously requested ${priorProfile.requestedSeasonStyle} style — briefly ask the customer ONCE whether to keep that style or base it on today's real conditions, then call resolve_season_preference.`;
          }
        }

        const profile = await saveCustomerProfileFields(conversationId, fields);
        return ok(
          `Verified "${result.city}" (${result.country || "country unknown"}) via ${result.source}. Weather fetched and saved automatically — never ask the customer what season it is, never explain that recommendations will be adjusted "accordingly"; just continue naturally (e.g. into preferences/dislikes).${conflictMessage}`,
          { type: "profile_progress", profile, missingFields: getMissingRequiredFields(profile) },
        );
      }

      case "resolve_season_preference": {
        const parsed = ResolveSeasonArgs.safeParse(args);
        if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
        const profile = await saveCustomerProfileFields(conversationId, {
          requestedSeasonStyle: parsed.data.choice === "keep_style" ? (await getCustomerProfile(conversationId)).requestedSeasonStyle : null,
          seasonStyleConflictResolved: true,
        });
        return ok(
          parsed.data.choice === "keep_style"
            ? `Resolved. Keeping the requested ${profile.requestedSeasonStyle} style as the basis. Never ask about this again.`
            : `Resolved. Basing the recommendation on today's real weather (${profile.weatherDirection}) instead. Never ask about this again.`,
          { type: "profile_progress", profile, missingFields: getMissingRequiredFields(profile) },
        );
      }

      case "select_recommendation": {
        const parsed = SelectRecommendationArgs.safeParse(args);
        if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
        const scratch = getScratch(conversationId);
        let activeList = scratch.lastCombinations || [];

        // Fix (legacy conversation recovery) — a conversation that predates the auto-preview flow,
        // or whose in-memory scratch was lost to a server restart (conversationScratch is an
        // in-memory Map, wiped on every redeploy exactly like chat.jsx's CONVERSATIONS cache), can
        // have nothing in memory to resolve "1"/"the second one" against even though real pending
        // recommendations still exist in the database. Rehydrate the most recent batch from
        // FragranceRecommendation rather than leaving an already-stuck conversation stuck.
        if (!activeList.length) {
          const pending = await prisma.fragranceRecommendation.findMany({
            where: { conversationId, status: "pending" },
            orderBy: { createdAt: "desc" },
            take: 10,
          });
          activeList = pending.reverse().map((r) => ({ recommendationId: r.id }));
          scratch.lastCombinations = activeList;
        }

        const result = parseRecommendationSelection(parsed.data.selectionText, activeList);
        if (result.noMatch) {
          return fail("couldn't tell which recommendation the customer means — ask one short clarifying question (e.g. 'Do you mean option 1, 2, or 3?').");
        }
        if (result.ambiguous) {
          return fail("the selection was ambiguous — ask the customer to confirm which option number they mean.");
        }
        const profile = await saveCustomerProfileFields(conversationId, { selectedRecommendationId: result.recommendationId });
        return ok(`Selected recommendationId ${result.recommendationId}. This is now the customer's chosen recommendation — never substitute a different one.`, {
          type: "recommendation_selected", recommendationId: result.recommendationId, profile,
        });
      }

      case "analyze_customer_product_candidates": {
        const profile = await getCustomerProfile(conversationId);
        const missing = getMissingRequiredFields(profile);
        if (missing.length) {
          return fail(`profile is missing required fields (${missing.join(", ")}) — ask the customer for these before analyzing.`);
        }
        const candidateProducts = await analyzeCustomerProductCandidates({ ...profile, season: effectiveQuerySeason(profile) });
        getScratch(conversationId, profile).candidateProducts = candidateProducts;
        if (!candidateProducts.length) {
          return ok("No real product candidates found for this profile yet — there may be limited historical data for this exact region/season combination.", {
            type: "analysis_progress",
            candidateProducts: [],
          });
        }
        return ok(
          `Real product candidates (highest relevance first): ${JSON.stringify(candidateProducts)}`,
          { type: "candidate_products", candidateProducts },
        );
      }

      case "get_product_notes_and_combination_status": {
        const parsed = ProductTitleArgs.safeParse(args);
        if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
        const result = await getProductNotesAndCombinationStatus(parsed.data.productTitle);
        return ok(JSON.stringify(result));
      }

      case "find_existing_combinations_for_product": {
        const parsed = ProductTitleArgs.safeParse(args);
        if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
        const result = await findExistingCombinationsForProduct(parsed.data.productTitle);
        return ok(JSON.stringify(result));
      }

      case "check_exact_combination_exists": {
        const parsed = CombinationExistsArgs.safeParse(args);
        if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
        const result = await checkExactCombinationExists(parsed.data.productTitles);
        return ok(JSON.stringify(result));
      }

      case "find_combinations_using_similar_notes": {
        const parsed = SimilarNotesArgs.safeParse(args);
        if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
        const result = await findCombinationsUsingSimilarNotes(parsed.data.productTitle, parsed.data.limit || 5);
        return ok(JSON.stringify(result));
      }

      case "generate_new_product_combinations": {
        const parsed = GenerateCombinationsArgs.safeParse(args);
        if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
        const profile = await getCustomerProfile(conversationId);
        const queriedProfile = { ...profile, season: effectiveQuerySeason(profile) };
        const scratch = getScratch(conversationId, profile);
        if (!scratch.candidateProducts) {
          scratch.candidateProducts = await analyzeCustomerProductCandidates(queriedProfile);
        }
        const combinations = await generateNewProductCombinations({
          profile: queriedProfile,
          candidateProducts: scratch.candidateProducts,
          maximumResults: parsed.data.maximumResults,
          allowedTypes: parsed.data.allowedTypes,
        });
        // Fix (persist the auto-confirm gate's own reasoning) — computed and attached before
        // saveRecommendation so it's part of the immutable, persisted record for every ranked
        // recommendation, not just recomputed transiently inside the confirm loop.
        combinations.forEach((c) => Object.assign(c, evaluateAutoConfirmEligibility(c, queriedProfile)));
        // Persist every proposal now (not just the one the customer eventually confirms) so a
        // later confirm_product_combination call always has a real, immutable, re-verifiable
        // record to point at by ID — never a free-form model reconstruction.
        const recommendationIds = await Promise.all(
          combinations.map((c) => saveRecommendation({ conversationId, profile, combination: c })),
        );
        const withIds = combinations.map((c, i) => ({ recommendationId: recommendationIds[i], ...c }));
        // Stored WITH recommendationId attached — this is the "currently active recommendation
        // list" select_recommendation resolves against (Fix 6).
        scratch.lastCombinations = withIds;
        if (!withIds.length) {
          return ok("No genuinely new combinations could be generated from the current candidates — every viable pairing already exists, or none had a clear complementary role.", {
            type: "combination_recommendations",
            combinations: [],
          });
        }

        // Fix (auto-preview flow) — the customer must never see a "pick one of five" screen; the
        // highest-ranked recommendation that still passes full re-verification is selected and
        // confirmed automatically. Shared with refine_combination_recommendations below — a
        // refinement request must open the preview the same way, never fall back to a list.
        const result = await autoSelectAndConfirmBest(withIds, conversationId, context);
        return result.ok ? ok(result.modelContent, result.sseEvent) : fail(result.modelContent);
      }

      case "refine_combination_recommendations": {
        const parsed = RefineArgs.safeParse(args);
        if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
        const profile = await getCustomerProfile(conversationId);
        const queriedProfile = { ...profile, season: effectiveQuerySeason(profile) };
        const scratch = getScratch(conversationId, profile);
        if (!scratch.candidateProducts) {
          scratch.candidateProducts = await analyzeCustomerProductCandidates(queriedProfile);
        }
        // Fix (refinement could only recognize notes already in a curated vocabulary) — the real
        // notes of whatever recommendation the customer is actually looking at right now (set by
        // autoSelectAndConfirmBest whenever a preview opens, including this tool's own previous
        // call) let ANY note they can see and name be recognized, not just pre-approved ones.
        let currentNotes = [];
        if (profile.selectedRecommendationId) {
          const currentRecommendation = await prisma.fragranceRecommendation.findUnique({
            where: { id: profile.selectedRecommendationId },
            select: { productsJson: true },
          });
          currentNotes = (currentRecommendation?.productsJson || []).flatMap((p) => p.notes || []);
        }
        const adjustments = deriveRefinementAdjustments(parsed.data.feedback, currentNotes);
        // Fix (refinement feedback never updated the stored profile) — a refinement request is a
        // real, explicit statement of preference ("I don't want sandalwood" plainly IS a dislike),
        // not just a one-off nudge for this regeneration round — confirmed live: the customer's own
        // stated exclusion never showed up on their profile at all. Persisted here using the same
        // literal-term-preferring shape save_customer_profile_field already uses, so the dashboard
        // and every later conversation/regeneration see it too, not just this one call.
        const updatedLikes = [...new Set([...(profile.likes || []), ...adjustments.addLikeTerms])];
        const updatedDislikes = [...new Set([...(profile.dislikes || []), ...adjustments.addDislikeTerms])];
        if (adjustments.addLikeTerms.length || adjustments.addDislikeTerms.length) {
          await saveCustomerProfileFields(conversationId, { likes: updatedLikes, dislikes: updatedDislikes });
        }
        const adjustedProfile = { ...queriedProfile, likes: updatedLikes, dislikes: updatedDislikes };
        // Fix (refinement "remove X" didn't actually remove X) — a customer's general stated
        // dislikes stay a soft signal (one incidental trace note never disqualifies a product,
        // per spec) — but confirmed live, that softness let a single buried "Sandalwood" note
        // survive a refinement explicitly asking to remove it, and the same combo won again
        // unchanged. The family(ies) named in THIS refinement turn specifically are hard-excluded
        // from every anchor/support candidate for this regeneration — a stronger, more immediate
        // guarantee than the general dislike system, scoped only to what was just asked to remove.
        // hardExcludeTerms is a second, narrower guarantee alongside it: a note recognized via
        // matchedRealNotesInText above but with no PREFERENCE_FAMILIES entry at all (so
        // textToPreferenceFamilies finds no family to hard-exclude by) still gets excluded directly,
        // by literally matching its own name against each candidate's real notes.
        const hardExcludeFamilies = textToPreferenceFamilies(adjustments.addDislikeTerms);
        const combinations = await generateNewProductCombinations({
          profile: adjustedProfile,
          candidateProducts: scratch.candidateProducts,
          allowedTypes: adjustments.allowedTypes,
          hardExcludeFamilies,
          hardExcludeTerms: adjustments.addDislikeTerms,
        });
        combinations.forEach((c) => Object.assign(c, evaluateAutoConfirmEligibility(c, adjustedProfile)));
        const recommendationIds = await Promise.all(
          combinations.map((c) => saveRecommendation({ conversationId, profile: adjustedProfile, combination: c })),
        );
        const withIds = combinations.map((c, i) => ({ recommendationId: recommendationIds[i], ...c }));
        scratch.lastCombinations = withIds;
        if (!withIds.length) {
          return ok(`No genuinely new combinations could be generated from "${parsed.data.feedback}" — every viable pairing already exists, or none had a clear complementary role.`, {
            type: "combination_recommendations",
            combinations: [],
          });
        }

        // Fix (auto-preview flow) — a refinement request ("make it sweeter", "remove the dark
        // chocolate") must open the preview automatically too, exactly like the first generation —
        // never fall back to a "pick one of N" list with Select/Refine/Create buttons.
        const result = await autoSelectAndConfirmBest(withIds, conversationId, context);
        return result.ok ? ok(result.modelContent, result.sseEvent) : fail(result.modelContent);
      }

      case "confirm_product_combination": {
        const parsed = RecommendationIdArgs.safeParse(args);
        if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
        // Fix 7 — the backend-stored selectedRecommendationId (set only by select_recommendation's
        // deterministic parser) is the source of truth, never the model's own argument. A retry
        // after a technical failure must land on the exact same recommendation, not a different one
        // the model might otherwise reconstruct.
        const profile = await getCustomerProfile(conversationId);
        const recommendationId = profile.selectedRecommendationId || parsed.data.recommendationId;
        if (profile.selectedRecommendationId && parsed.data.recommendationId !== profile.selectedRecommendationId) {
          return fail(`the customer's selected recommendation is ${profile.selectedRecommendationId} — use that one, never a different id.`);
        }
        const result = await confirmRecommendation({
          recommendationId,
          customerName: context.customerName,
          customerEmail: context.customerEmail,
        });
        if (!result.ok) {
          // Fix 7 — a confirmation failure (technical issue, expiry, etc.) never clears the
          // customer's selection and never triggers a new recommendation; the model is told to
          // retry the SAME id, never substitute another.
          return fail(`${result.reason} Keep the customer's selected recommendation unchanged — do not propose a different one. You may retry confirm_product_combination with the same recommendationId.`);
        }
        // Fix (fragrance preview page) — creation is now DEFERRED. Confirming just opens the
        // preview page (Top/Middle/Base sliders, real component names/notes, Recreate/Save
        // Build/Add to Cart) — nothing is created in Shopify at this point. This tool is no longer
        // needed for the primary new-conversation flow (generate_new_product_combinations now
        // auto-selects and auto-confirms the best recommendation by itself) — it's kept only for
        // legacy conversations that already have a manually-selected recommendationId.
        const legacyPreviewUrl = await buildPreviewUrl(recommendationId);
        logPreviewEvent("PREVIEW_READY_EMITTED", {
          conversationId, recommendationId, previewId: recommendationId, eventType: "preview_ready", previewUrl: legacyPreviewUrl,
        });
        return ok(
          `Confirmed. Tell the customer their fragrance preview is ready — do NOT say a product has been created yet. The frontend will open the preview page automatically.`,
          { type: "preview_ready", recommendationId, previewId: recommendationId, previewUrl: legacyPreviewUrl },
        );
      }

      default:
        return fail(`unknown tool "${toolName}".`);
    }
  } catch (err) {
    console.error(`fragranceAgentTools: ${toolName} failed:`, err);
    return fail(`internal error while running ${toolName}.`);
  }
}
