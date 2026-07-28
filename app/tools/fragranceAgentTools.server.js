// Phase 9 — the 11 required MCP/AI tools, in the same OpenAI function-calling format the existing
// tools in app/routes/chat.jsx already use (type: "function", function: {name, description,
// parameters}). executeFragranceTool() is the single dispatch point chat.jsx's tool-call loop
// invokes; every handler validates its parsed arguments with Zod before touching a service, and
// every handler talks to real data only — no handler ever invents a product, note, score, or ratio.
import { z } from "zod";
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
import { generateNewProductCombinations } from "../services/recommendationEngine.server.js";
import { saveRecommendation, confirmRecommendation, getRecommendation } from "../services/recommendationConfirmation.server.js";
import { verifyCity, fetchCurrentWeather } from "../services/locationVerification.server.js";
import { describeWeatherSimple, hasSeasonWeatherConflict } from "../utils/weatherSeason.js";
import { parseRecommendationSelection } from "../utils/recommendationSelectionParser.js";

// Fix 3 — strips every internal field (real source product titles/notes, raw scores/reasons) from
// a freshly-generated in-memory combination before it is ever handed to the model's own narration
// or an SSE customer payload. Mirrors recommendationConfirmation.server.js's
// toCustomerSafeRecommendation, but operates on the in-memory generator output (which already has
// the customerFacing* fields flattened, not nested under customerFacingJson).
function toCustomerSafeCombo(withIdCombo) {
  const {
    recommendationId, type, existsAlready, evidenceScope, confidence,
    customerFacingName, customerFacingDescription, customerFacingWhySuits,
    customerFacingBestUse, customerFacingWeatherSuitability, customerFacingStrength, customerFacingRisk,
  } = withIdCombo;
  return {
    recommendationId, type, existsAlready, evidenceScope, confidence,
    customerFacingName, customerFacingDescription, customerFacingWhySuits,
    customerFacingBestUse, customerFacingWeatherSuitability, customerFacingStrength, customerFacingRisk,
  };
}

// Ephemeral, regenerable per-conversation scratch space — NOT the durable CustomerProfileState.
// Holds the last analyze_customer_product_candidates/generate_new_product_combinations results so
// generate_new_product_combinations, refine_combination_recommendations, and
// confirm_product_combination don't require the model to re-transmit a whole scored candidate or
// combination array (which it could only do by retyping/hallucinating the numbers). Lost on server
// restart exactly like chat.jsx's own CONVERSATIONS cache — always safe to regenerate from a fresh
// analyze_customer_product_candidates call.
const conversationScratch = new Map(); // conversationId -> { candidateProducts, lastCombinations }

function getScratch(conversationId) {
  if (!conversationScratch.has(conversationId)) {
    conversationScratch.set(conversationId, { candidateProducts: null, lastCombinations: null });
  }
  return conversationScratch.get(conversationId);
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
  season: z.enum(VALID_SEASONS),
  likes: z.array(z.string().min(1)).max(20),
  dislikes: z.array(z.string().min(1)).max(20),
  preferredStyle: z.string().min(1).max(200),
  occasion: z.string().min(1).max(200),
  strengthPreference: z.enum(VALID_STRENGTH_PREFERENCES),
  additionalPreferences: z.array(z.string().min(1)).max(20),
};
const PROFILE_FIELD_NAMES = Object.keys(PROFILE_FIELD_SCHEMAS);

const SaveProfileFieldArgs = z.object({
  field: z.enum(PROFILE_FIELD_NAMES),
  value: z.union([z.string(), z.array(z.string())]),
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
const ResolveSeasonArgs = z.object({ choice: z.enum(["keep_stated", "use_weather"]) });
const SelectRecommendationArgs = z.object({ selectionText: z.string().min(1).max(200) });
const CreateProductArgs = z.object({
  recommendationId: z.string().min(1),
  customName: z.string().min(1).max(200),
  description: z.string().min(1).max(1000),
});

// ============================================================
// Tool definitions (OpenAI function-calling format)
// ============================================================
export const FRAGRANCE_AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "save_customer_profile_field",
      description: "Save one field of the customer's structured fragrance profile (name, email, city, stateRegion, country, season, likes, dislikes, preferredStyle, occasion, strengthPreference, additionalPreferences). Call this every time the customer gives you a real answer for one of these — never track profile progress in your own memory.",
      parameters: {
        type: "object",
        properties: {
          field: { type: "string", enum: PROFILE_FIELD_NAMES, description: "Which profile field to set." },
          value: {
            description: "The value for this field. A plain string for most fields; an array of strings for likes/dislikes/additionalPreferences.",
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
      description: "Get the customer's current structured fragrance profile and which required fields (city, country, season, likes-or-preferredStyle) are still missing before analysis can run.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_customer_product_candidates",
      description: "Deterministically score real DUA products against the customer's current profile using real order-history evidence (region, season, likes/dislikes, repeat-purchase and popularity signals). Returns up to 10 real ProductCandidate results. Requires city, country, season, and at least one like or preferredStyle to already be saved on the profile.",
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
      description: "Verify a city the customer typed against real order-history data and real geocoding — NEVER accept a city as real just because it sounds plausible (e.g. a fictional place). Call this before saving city/country to the profile. If needsClarification is true, ask the customer which real place they mean from the candidates. If verified is false, tell the customer you couldn't confidently match that location and ask for a real city.",
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
      name: "get_live_weather",
      description: "Fetch real current weather for the customer's already-VERIFIED city (requires verify_customer_location to have succeeded first). Returns simple weather words (never exact temperatures) and whether it conflicts with the customer's stated season. Only call this when there's a real reason to — a stated season/weather mismatch to check, the customer asking about weather, or it would materially change the recommendation. Do not call this automatically every conversation.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "resolve_season_preference",
      description: "Call this exactly once, only after get_live_weather reported a real conflict with the customer's stated season, and only after the customer has answered which direction they want. choice='keep_stated' keeps their stated season as the style basis; choice='use_weather' bases the recommendation on today's real conditions instead. Never call this again once already resolved for this conversation.",
      parameters: {
        type: "object",
        properties: { choice: { type: "string", enum: ["keep_stated", "use_weather"], description: "Which direction the customer picked." } },
        required: ["choice"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "select_recommendation",
      description: "Call this whenever the customer picks one of the currently shown recommendations, in whatever words they use ('option 1', 'opt 1 is good', 'the first one', 'number 2', 'I want the last one', 'create this'). Pass their message text through as-is — never try to figure out the recommendationId yourself from the product description. This deterministically resolves it against the currently active recommendation list.",
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
      description: "Generate genuinely new Hybrid/Tribrid/Quadbrid combination proposals — built from the customer's top real product candidates plus compatible real supporting products — scored on preference match, seasonal fit, historical evidence, note compatibility, balance, and risk. NEVER proposes a combination that already exists. Call analyze_customer_product_candidates first in this conversation if you haven't yet.",
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
      description: "Re-generate combination recommendations based on the customer's feedback on the last set shown (e.g. 'make it sweeter', 'remove spicy notes', 'show me fresher combinations', 'give me only new combinations', 'give me a Hybrid only'). Reuses the existing profile and candidate analysis rather than restarting the conversation.",
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
      description: "Call this ONLY after the customer has explicitly confirmed (said something like 'yes' / 'create that one') one specific recommendation by its recommendationId. Deterministically re-verifies everything (products still exist, notes exist, combination is still genuinely new, ratios sum to 100%, no high-severity dislike conflict) before allowing product creation.",
      parameters: {
        type: "object",
        properties: { recommendationId: { type: "string", description: "The exact recommendationId of the one specific combination the customer confirmed." } },
        required: ["recommendationId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_shopify_custom_combination_product",
      description: "Create the real Shopify product for a recommendation that confirm_product_combination has already successfully confirmed. Never call this before confirm_product_combination has returned success for the same recommendationId.",
      parameters: {
        type: "object",
        properties: {
          recommendationId: { type: "string", description: "The same recommendationId just confirmed." },
          customName: { type: "string", description: "A unique, creative, personalized name for the combination fragrance itself (your own creative name, or one the customer gave)." },
          description: { type: "string", description: "A short, appealing 1-2 sentence product description." },
        },
        required: ["recommendationId", "customName", "description"],
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
const REFINEMENT_LIKE_KEYWORDS = [
  { pattern: /\bfresh(er)?\b/i, family: "Fresh" },
  { pattern: /\bsweet(er)?\b/i, family: "Sweet" },
  { pattern: /\bfruit(y|ier)?\b/i, family: "Fruity" },
];
const REFINEMENT_DISLIKE_KEYWORDS = [
  { pattern: /\bremove spicy|\bless spicy|no spicy/i, family: "Spicy" },
  { pattern: /\bless strong|not (as )?strong|lighter/i, family: "Strong" },
];
const ONLY_NEW_PATTERN = /\bonly new\b|\bnew combinations? only\b/i;

function deriveRefinementAdjustments(feedback) {
  const addLikes = REFINEMENT_LIKE_KEYWORDS.filter((k) => k.pattern.test(feedback)).map((k) => k.family);
  const addDislikes = REFINEMENT_DISLIKE_KEYWORDS.filter((k) => k.pattern.test(feedback)).map((k) => k.family);
  const typeMatch = REFINEMENT_TYPE_KEYWORDS.find((k) => k.pattern.test(feedback));
  return {
    addLikes,
    addDislikes,
    allowedTypes: typeMatch ? typeMatch.types : undefined,
    onlyNew: ONLY_NEW_PATTERN.test(feedback), // always true anyway — this engine never proposes existing combos
  };
}

// ============================================================
// Dispatch
// ============================================================
/**
 * @param {string} toolName
 * @param {string} rawArgsJson - the tool call's raw JSON argument string.
 * @param {object} context - { conversationId, customerName, customerEmail }.
 * @returns {Promise<{modelContent: string, sseEvent: object|null, readyForShopifyCreation: {recommendationId: string, customName: string, description: string}|null}>}
 *   readyForShopifyCreation is populated when create_shopify_custom_combination_product has been
 *   validated and is ready for chat.jsx's action handler (which owns the Shopify `admin` client) to
 *   actually create the product — mirrors how the old confirm_scent_combination tool handed
 *   `comboConfirmed` back to the action handler instead of creating the product itself.
 */
export async function executeFragranceTool(toolName, rawArgsJson, context) {
  const { conversationId } = context;
  const fail = (message) => ({ modelContent: `Error: ${message}`, sseEvent: null, readyForShopifyCreation: null });
  const ok = (modelContent, sseEvent = null) => ({ modelContent, sseEvent, readyForShopifyCreation: null });

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
        const fieldSchema = PROFILE_FIELD_SCHEMAS[parsed.data.field];
        const valueParsed = fieldSchema.safeParse(parsed.data.value);
        if (!valueParsed.success) {
          return fail(`invalid value for field "${parsed.data.field}": ${valueParsed.error.issues.map((i) => i.message).join("; ")}`);
        }
        const profile = await saveCustomerProfileField(conversationId, parsed.data.field, valueParsed.data);
        const missing = getMissingRequiredFields(profile);
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
        const profile = await saveCustomerProfileFields(conversationId, {
          city: result.city,
          country: result.country || (await getCustomerProfile(conversationId)).country,
          locationVerified: true,
          locationSource: result.source,
        });
        return ok(`Verified "${result.city}" (${result.country || "country unknown"}) via ${result.source}. Saved to profile.`, {
          type: "profile_progress", profile, missingFields: getMissingRequiredFields(profile),
        });
      }

      case "get_live_weather": {
        const profile = await getCustomerProfile(conversationId);
        if (!profile.locationVerified || !profile.city) {
          return fail("the customer's city isn't verified yet — call verify_customer_location first.");
        }
        const weather = await fetchCurrentWeather(profile.city);
        if (!weather) return fail("couldn't fetch live weather right now — don't mention weather to the customer, just proceed with their stated preferences.");
        const { words, summary } = describeWeatherSimple(weather.tempF, weather.weatherCode);
        const tempC = Math.round(((weather.tempF - 32) * 5) / 9);
        const conflict = hasSeasonWeatherConflict(profile.season, words);
        const updated = await saveCustomerProfileFields(conversationId, {
          currentWeather: { condition: summary, temperatureC: tempC, temperatureF: weather.tempF, fetchedAt: new Date().toISOString() },
          weatherLocation: { city: profile.city, country: profile.country, verified: true },
        });
        const conflictAlreadyResolved = updated.seasonConflictResolved;
        return ok(
          `Current weather in ${profile.city}: ${summary}. ` +
            (conflict && !conflictAlreadyResolved
              ? `This conflicts with the customer's stated ${profile.season}. Ask them ONCE whether they want the ${profile.season}-style direction or a direction based on today's actual conditions, then call resolve_season_preference with their answer.`
              : `No unresolved conflict with the stated season — do not ask about it again.`),
          { type: "weather_progress", currentWeather: updated.currentWeather, conflict: conflict && !conflictAlreadyResolved },
        );
      }

      case "resolve_season_preference": {
        const parsed = ResolveSeasonArgs.safeParse(args);
        if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
        const profile = await saveCustomerProfileFields(conversationId, {
          seasonSource: parsed.data.choice === "keep_stated" ? "customer_confirmed_style" : "weather_confirmed",
          seasonConflictResolved: true,
        });
        return ok(`Resolved. Season stays "${profile.season}", basis: ${profile.seasonSource}. Never ask about this conflict again.`, {
          type: "profile_progress", profile, missingFields: getMissingRequiredFields(profile),
        });
      }

      case "select_recommendation": {
        const parsed = SelectRecommendationArgs.safeParse(args);
        if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
        const scratch = getScratch(conversationId);
        const activeList = scratch.lastCombinations || [];
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
        const candidateProducts = await analyzeCustomerProductCandidates(profile);
        getScratch(conversationId).candidateProducts = candidateProducts;
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
        const scratch = getScratch(conversationId);
        if (!scratch.candidateProducts) {
          scratch.candidateProducts = await analyzeCustomerProductCandidates(profile);
        }
        const combinations = await generateNewProductCombinations({
          profile,
          candidateProducts: scratch.candidateProducts,
          maximumResults: parsed.data.maximumResults,
          allowedTypes: parsed.data.allowedTypes,
        });
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
        // Fix 3 — never hands the model (or the SSE payload) internalProducts/real source titles;
        // only the customer-safe fields the model needs to narrate the recommendation.
        const customerSafe = withIds.map(toCustomerSafeCombo);
        return ok(
          `Generated new combination proposals (each has a recommendationId — use it with select_recommendation/confirm_product_combination, never re-derive it): ${JSON.stringify(customerSafe)}`,
          { type: "combination_recommendations", combinations: customerSafe },
        );
      }

      case "refine_combination_recommendations": {
        const parsed = RefineArgs.safeParse(args);
        if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
        const profile = await getCustomerProfile(conversationId);
        const scratch = getScratch(conversationId);
        if (!scratch.candidateProducts) {
          scratch.candidateProducts = await analyzeCustomerProductCandidates(profile);
        }
        const adjustments = deriveRefinementAdjustments(parsed.data.feedback);
        // One-off bias for this regeneration only — not persisted to the stored profile, since a
        // refinement request ("make it sweeter") is a request about THIS recommendation round, not
        // necessarily a permanent change to the customer's stated preferences.
        const adjustedProfile = {
          ...profile,
          likes: [...new Set([...(profile.likes || []), ...adjustments.addLikes])],
          dislikes: [...new Set([...(profile.dislikes || []), ...adjustments.addDislikes])],
        };
        const combinations = await generateNewProductCombinations({
          profile: adjustedProfile,
          candidateProducts: scratch.candidateProducts,
          allowedTypes: adjustments.allowedTypes,
        });
        const recommendationIds = await Promise.all(
          combinations.map((c) => saveRecommendation({ conversationId, profile: adjustedProfile, combination: c })),
        );
        const withIds = combinations.map((c, i) => ({ recommendationId: recommendationIds[i], ...c }));
        scratch.lastCombinations = withIds;
        const customerSafe = withIds.map(toCustomerSafeCombo);
        return ok(
          `Refined combination proposals based on "${parsed.data.feedback}": ${JSON.stringify(customerSafe)}`,
          { type: "recommendation_refined", combinations: customerSafe },
        );
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
        return ok(
          `Confirmed. recommendationId ${recommendationId} is ready — call create_shopify_custom_combination_product next.`,
          { type: "recommendation_confirmed", recommendationId },
        );
      }

      case "create_shopify_custom_combination_product": {
        const parsed = CreateProductArgs.safeParse(args);
        if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
        const record = await getRecommendation(parsed.data.recommendationId);
        if (!record) return fail("recommendation not found.");
        if (record.status !== "confirmed") {
          return fail("this recommendation hasn't been confirmed yet — call confirm_product_combination first.");
        }
        if (record.shopifyProductId) {
          return fail("a Shopify product has already been created for this recommendation.");
        }
        return {
          modelContent: "Creating the Shopify product now — tell the customer it's on its way.",
          sseEvent: null,
          readyForShopifyCreation: {
            recommendationId: parsed.data.recommendationId,
            customName: parsed.data.customName,
            description: parsed.data.description,
          },
        };
      }

      default:
        return fail(`unknown tool "${toolName}".`);
    }
  } catch (err) {
    console.error(`fragranceAgentTools: ${toolName} failed:`, err);
    return fail(`internal error while running ${toolName}.`);
  }
}
