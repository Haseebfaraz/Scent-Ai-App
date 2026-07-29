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
import {
  describeWeatherSimple, deriveWeatherDirection, weatherDirectionToQuerySeason,
  hasSeasonWeatherConflict, getCalendarSeason,
} from "../utils/weatherSeason.js";
import { parseRecommendationSelection } from "../utils/recommendationSelectionParser.js";
import { textToPreferenceFamilies } from "../utils/fragranceCompatibility.js";

// Fix (profile normalization) — a preferredStyle answer that's actually a non-answer ("you should
// know", "surprise me") carries no real style signal. Deriving a deterministic guess from whatever
// real signal already exists (likes, additional preferences, requested season style) means the
// profile still has something real to generate from, without ever inventing a preference the
// customer never gave — labeled internally as "inferred," never presented to the customer as a
// literal fact they stated.
const NO_REAL_STYLE_PATTERN = /you should know|you decide|surprise me|not sure|no preference|i ?don'?t know|\bidk\b|whatever you (think|want|pick)/i;
const NO_REAL_VALUE_PATTERN = /^(na|n\/a|none|nothing|no)$/i;
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
  requestedSeasonStyle: z.enum(VALID_SEASONS),
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
const ResolveSeasonArgs = z.object({ choice: z.enum(["keep_style", "use_weather"]) });
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
      description: "Save one field of the customer's structured fragrance profile (name, email, city, stateRegion, country, requestedSeasonStyle, likes, dislikes, preferredStyle, occasion, strengthPreference, additionalPreferences). Call this every time the customer gives you a real answer for one of these — never track profile progress in your own memory. requestedSeasonStyle is ONLY for when the customer volunteers a specific seasonal style unprompted (e.g. 'I want something wintery') — never ask them what season it is or what season they associate with an occasion; live weather is handled automatically once their city is verified.",
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
  // Previously missing entirely — a refinement request like "focus on spicy" or "spicier" silently
  // matched nothing here, so it never actually biased regeneration despite the model's narration
  // claiming otherwise. Confirmed against real production data (recommendation batches that kept
  // returning sweet/fresh combinations after repeated "spicier" refinement requests).
  { pattern: /\bspic(y|ier|e)?\b/i, family: "Spicy" },
  { pattern: /\bwood(y|ier)?\b/i, family: "Woody" },
  { pattern: /\bmusk(y)?\b/i, family: "Musk" },
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
        const profile = await saveCustomerProfileField(conversationId, parsed.data.field, valueParsed.data);
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
        const candidateProducts = await analyzeCustomerProductCandidates({ ...profile, season: effectiveQuerySeason(profile) });
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
        const queriedProfile = { ...profile, season: effectiveQuerySeason(profile) };
        const scratch = getScratch(conversationId);
        if (!scratch.candidateProducts) {
          scratch.candidateProducts = await analyzeCustomerProductCandidates(queriedProfile);
        }
        const combinations = await generateNewProductCombinations({
          profile: queriedProfile,
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
        const queriedProfile = { ...profile, season: effectiveQuerySeason(profile) };
        const scratch = getScratch(conversationId);
        if (!scratch.candidateProducts) {
          scratch.candidateProducts = await analyzeCustomerProductCandidates(queriedProfile);
        }
        const adjustments = deriveRefinementAdjustments(parsed.data.feedback);
        // One-off bias for this regeneration only — not persisted to the stored profile, since a
        // refinement request ("make it sweeter") is a request about THIS recommendation round, not
        // necessarily a permanent change to the customer's stated preferences.
        const adjustedProfile = {
          ...queriedProfile,
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
