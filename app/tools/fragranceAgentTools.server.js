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
        scratch.lastCombinations = combinations;
        // Persist every proposal now (not just the one the customer eventually confirms) so a
        // later confirm_product_combination call always has a real, immutable, re-verifiable
        // record to point at by ID — never a free-form model reconstruction.
        const recommendationIds = await Promise.all(
          combinations.map((c) => saveRecommendation({ conversationId, profile, combination: c })),
        );
        const withIds = combinations.map((c, i) => ({ recommendationId: recommendationIds[i], ...c }));
        if (!withIds.length) {
          return ok("No genuinely new combinations could be generated from the current candidates — every viable pairing already exists, or none had a clear complementary role.", {
            type: "combination_recommendations",
            combinations: [],
          });
        }
        return ok(
          `Generated new combination proposals (each has a recommendationId to use later with confirm_product_combination): ${JSON.stringify(withIds)}`,
          { type: "combination_recommendations", combinations: withIds },
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
        scratch.lastCombinations = combinations;
        const recommendationIds = await Promise.all(
          combinations.map((c) => saveRecommendation({ conversationId, profile: adjustedProfile, combination: c })),
        );
        const withIds = combinations.map((c, i) => ({ recommendationId: recommendationIds[i], ...c }));
        return ok(
          `Refined combination proposals based on "${parsed.data.feedback}": ${JSON.stringify(withIds)}`,
          { type: "recommendation_refined", combinations: withIds },
        );
      }

      case "confirm_product_combination": {
        const parsed = RecommendationIdArgs.safeParse(args);
        if (!parsed.success) return fail(parsed.error.issues.map((i) => i.message).join("; "));
        const result = await confirmRecommendation({
          recommendationId: parsed.data.recommendationId,
          customerName: context.customerName,
          customerEmail: context.customerEmail,
        });
        if (!result.ok) return fail(result.reason);
        return ok(
          `Confirmed. recommendationId ${parsed.data.recommendationId} is ready — call create_shopify_custom_combination_product next.`,
          { type: "recommendation_confirmed", recommendationId: parsed.data.recommendationId },
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
