// Regression tests for the auto-preview-flow fix — the customer must never see a "pick one of
// five" screen and must never need to type "1"/"yes"/"preview" for a NEW recommendation; the
// backend deterministically selects and confirms the best one and emits preview_ready on its own.
// generate_new_product_combinations/select_recommendation/confirmRecommendation are all pure
// backend logic (no OpenAI call inside them — only chat.jsx's callAI() calls OpenAI), so this
// exercises the real fix directly against the real catalog/database, the same pattern
// aniqRegression.test.js already uses.
import { describe, it, expect } from "vitest";
import { executeFragranceTool, __deriveRefinementAdjustmentsForTesting as deriveRefinementAdjustments } from "../tools/fragranceAgentTools.server.js";
import { saveRecommendation } from "./recommendationConfirmation.server.js";
import { resolveLegacyPreviewShortCircuit } from "./legacyPreviewRecovery.server.js";
import { buildPreviewUrl } from "../utils/previewUrl.server.js";
import { saveCustomerProfileFields, getCustomerProfile } from "./customerProfile.server.js";
import prisma from "../db.server.js";

function freshConversationId(label) {
  return `vitest-autopreview-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Fix (test reliability) — sets the same city/country/locationVerified fields
// verify_customer_location would have set, without calling it: that tool also fetches real live
// weather (fetchCurrentWeather), a real network call these auto-preview-flow tests have nothing to
// do with. Los Angeles resolves via the fast, real order-history path for the city/country fields
// themselves either way, so this is the same real data, just without the unrelated live weather call.
async function verifyLosAngelesWithoutNetwork(conversationId) {
  await saveCustomerProfileFields(conversationId, {
    city: "Los Angeles", country: "United States", locationVerified: true, locationSource: "order_history",
  });
}

describe("generate_new_product_combinations — auto-select + auto-confirm (Test 1/2)", () => {
  it("emits preview_ready for the best recommendation instead of a combination list, with no customer input needed", async () => {
    const conversationId = freshConversationId("best");
    const ctx = { conversationId, customerName: "Test Customer", customerEmail: "test@example.com" };
    try {
      await verifyLosAngelesWithoutNetwork(conversationId);
      await executeFragranceTool("save_customer_profile_field", JSON.stringify({ field: "likes", value: ["Fruity"] }), ctx);

      const result = await executeFragranceTool("generate_new_product_combinations", "{}", ctx);

      expect(result.modelContent).not.toMatch(/^Error/);
      expect(result.sseEvent).toBeTruthy();
      expect(result.sseEvent.type).toBe("preview_ready");
      expect(result.sseEvent.recommendationId).toBeTruthy();
      // Absolute URL, on this app's own domain — the widget runs on the storefront domain, so a
      // relative path would resolve against the wrong origin (see previewUrl.server.js).
      expect(result.sseEvent.previewUrl).toBe(buildPreviewUrl(result.sseEvent.recommendationId));
      expect(() => new URL(result.sseEvent.previewUrl)).not.toThrow();

      // The customer must never be shown a list to pick from — this event type is retired for
      // the auto-preview success path.
      expect(result.sseEvent.type).not.toBe("combination_recommendations");

      // The recommendation really is confirmed in the database, not just narrated as if it were.
      const record = await prisma.fragranceRecommendation.findUnique({ where: { id: result.sseEvent.recommendationId } });
      expect(record.status).toBe("confirmed");
    } finally {
      await prisma.customerProfileState.deleteMany({ where: { conversationId } });
    }
  }, 60000);

  it("tells the model explicitly not to list combinations or ask the customer to pick one", async () => {
    const conversationId = freshConversationId("instruction");
    const ctx = { conversationId, customerName: "Test Customer", customerEmail: "test@example.com" };
    try {
      await verifyLosAngelesWithoutNetwork(conversationId);
      await executeFragranceTool("save_customer_profile_field", JSON.stringify({ field: "likes", value: ["Fruity"] }), ctx);

      const result = await executeFragranceTool("generate_new_product_combinations", "{}", ctx);
      expect(result.modelContent).toMatch(/do not list|do not ask/i);
    } finally {
      await prisma.customerProfileState.deleteMany({ where: { conversationId } });
    }
  }, 60000);
});

describe("refine_combination_recommendations — auto-select + auto-confirm (real bug: Recreate refinement showed a card list)", () => {
  it("emits preview_ready for the best refined recommendation instead of a combination list, same as a first generation", async () => {
    const conversationId = freshConversationId("refine");
    const ctx = { conversationId, customerName: "Test Customer", customerEmail: "test@example.com" };
    try {
      await verifyLosAngelesWithoutNetwork(conversationId);
      await executeFragranceTool("save_customer_profile_field", JSON.stringify({ field: "likes", value: ["Fruity"] }), ctx);
      // Exactly the reported flow: an initial generation, then feedback ("Dont want Dark
      // Chocolate") that used to fall back to the old Select/Refine/Create card list.
      await executeFragranceTool("generate_new_product_combinations", "{}", ctx);

      const result = await executeFragranceTool(
        "refine_combination_recommendations",
        JSON.stringify({ feedback: "make it fresher" }),
        ctx,
      );

      expect(result.modelContent).not.toMatch(/^Error/);
      expect(result.sseEvent).toBeTruthy();
      expect(result.sseEvent.type).toBe("preview_ready");
      expect(result.sseEvent.type).not.toBe("recommendation_refined");
      expect(result.sseEvent.recommendationId).toBeTruthy();
      expect(result.sseEvent.previewUrl).toBe(buildPreviewUrl(result.sseEvent.recommendationId));

      const record = await prisma.fragranceRecommendation.findUnique({ where: { id: result.sseEvent.recommendationId } });
      expect(record.status).toBe("confirmed");
    } finally {
      await prisma.customerProfileState.deleteMany({ where: { conversationId } });
    }
  }, 60000);
});

describe("deriveRefinementAdjustments — direction fix (real bug: 'less X' matched nothing, or landed as a like)", () => {
  it("puts a negated family in dislikes, not likes", () => {
    const result = deriveRefinementAdjustments("less sweet");
    expect(result.addDislikes).toContain("Sweet");
    expect(result.addLikes).not.toContain("Sweet");
  });

  it("resolves each clause's own family against ITS OWN negation", () => {
    const result = deriveRefinementAdjustments("less woody, more fruity");
    expect(result.addDislikes).toContain("Woody");
    expect(result.addLikes).toContain("Fruity");
    expect(result.addDislikes).not.toContain("Fruity");
    expect(result.addLikes).not.toContain("Woody");
  });

  it("recognizes generic negation phrasing beyond the old fixed 'remove spicy'/'less strong' phrases", () => {
    expect(deriveRefinementAdjustments("no musk please").addDislikes).toContain("Musk");
    expect(deriveRefinementAdjustments("I don't want it too powdery").addDislikes).toContain("Powdery");
    expect(deriveRefinementAdjustments("can you take out the heavy notes").addDislikes).toContain("Strong");
  });

  // Real bug: a customer naming actual notes ("remove patchouli vanilla, Sandal wood") got nothing
  // removed but the very first named note — REFINEMENT_FAMILY_KEYWORDS never covered literal note
  // names at all, and the negation from "remove" didn't carry past the first comma-split clause.
  it("recognizes literal note names, not just generic descriptor words", () => {
    const result = deriveRefinementAdjustments("remove patchouli, vanilla, sandalwood");
    expect(result.addDislikes.some((f) => f.toLowerCase().includes("wood"))).toBe(true);
    expect(result.addDislikes.some((f) => f.toLowerCase().includes("sweet"))).toBe(true);
    expect(result.addLikes.length).toBe(0);
  });

  it("carries a negation forward across a comma-separated list until a positive word flips it back", () => {
    const result = deriveRefinementAdjustments("remove patchouli vanilla, Sandal wood");
    // "Sandal wood" is the SECOND clause, after the comma, with no negation word of its own — the
    // bug was this clause defaulting back to a like.
    expect(result.addDislikes.some((f) => f.toLowerCase().includes("wood"))).toBe(true);
    expect(result.addLikes.some((f) => f.toLowerCase().includes("wood"))).toBe(false);
  });
});

// Fix (refinement feedback never updated the stored profile) — addLikes/addDislikes above are
// FAMILY keys used only for the one-off regeneration bias; addLikeTerms/addDislikeTerms are what
// actually get persisted to the customer's real likes/dislikes fields, same literal-note-preferring
// shape save_customer_profile_field already uses elsewhere.
describe("deriveRefinementAdjustments — addLikeTerms/addDislikeTerms (what gets persisted to the profile)", () => {
  it("persists the literal note the customer named, not the family label, when one was given", () => {
    const result = deriveRefinementAdjustments("dont want sandalwood");
    expect(result.addDislikeTerms).toContain("sandalwood");
    expect(result.addDislikeTerms).not.toContain("woody");
  });

  it("falls back to the matched family label when the clause is a pure style word with no specific note", () => {
    const result = deriveRefinementAdjustments("less woody");
    expect(result.addDislikeTerms.some((t) => t.toLowerCase().includes("wood"))).toBe(true);
  });

  it("keeps each named literal note separate across a multi-item list", () => {
    const result = deriveRefinementAdjustments("remove patchouli, vanilla, sandalwood");
    expect(result.addDislikeTerms).toEqual(expect.arrayContaining(["patchouli", "sandalwood"]));
  });

  it("a stated exclusion wins over an incidental positive mention of the same term elsewhere in the message", () => {
    const result = deriveRefinementAdjustments("less woody, more fruity");
    expect(result.addLikeTerms.some((t) => t.toLowerCase().includes("wood"))).toBe(false);
  });
});

describe("refine_combination_recommendations — no-op bug (real bug: refinement outside the old 5-keyword list changed nothing)", () => {
  it("actually carries a family the old keyword list didn't recognize into the regenerated recommendation's profile", async () => {
    const conversationId = freshConversationId("refine-dislike");
    const ctx = { conversationId, customerName: "Test Customer", customerEmail: "test@example.com" };
    try {
      await verifyLosAngelesWithoutNetwork(conversationId);
      await executeFragranceTool("save_customer_profile_field", JSON.stringify({ field: "likes", value: ["Fruity"] }), ctx);
      await executeFragranceTool("generate_new_product_combinations", "{}", ctx);

      // "no musk" matched nothing under the old REFINEMENT_DISLIKE_KEYWORDS list (it only covered
      // "spicy"/"strong" via a few fixed literal phrases) — deriveRefinementAdjustments returned
      // empty addDislikes, so the profile passed into generateNewProductCombinations was byte-
      // identical to the original and the "refined" result was the same combination back, just with
      // a new id/name. This proves the family now actually reaches the regenerated profile — the
      // resulting scoring/severity tradeoff (a product doesn't get hard-rejected for one minor
      // supporting note, per classifyDislikeConflict's own deliberate design) is untouched by this
      // fix and is out of scope here.
      const result = await executeFragranceTool(
        "refine_combination_recommendations",
        JSON.stringify({ feedback: "no musk please" }),
        ctx,
      );

      expect(result.modelContent).not.toMatch(/^Error/);
      expect(result.sseEvent.type).toBe("preview_ready");

      const record = await prisma.fragranceRecommendation.findUnique({ where: { id: result.sseEvent.recommendationId } });
      expect(record.customerProfileJson.dislikes).toContain("Musk");
    } finally {
      await prisma.customerProfileState.deleteMany({ where: { conversationId } });
    }
  }, 60000);
});

// Fix (refinement feedback never updated the stored profile) — real bug: a customer's explicit
// refinement request ("I don't want sandalwood") is plainly a real dislike, but it only ever biased
// this one regeneration — the customer's actual stored likes/dislikes (what the admin dashboard
// shows, and what every LATER conversation/regeneration reads) never changed at all.
describe("refine_combination_recommendations — persists the refinement into the stored profile", () => {
  it("adds the literally-named note to the customer's real dislikes field, not just this one regeneration", async () => {
    const conversationId = freshConversationId("refine-persist");
    const ctx = { conversationId, customerName: "Test Customer", customerEmail: "test@example.com" };
    try {
      await verifyLosAngelesWithoutNetwork(conversationId);
      await executeFragranceTool("save_customer_profile_field", JSON.stringify({ field: "likes", value: ["Fruity"] }), ctx);
      await executeFragranceTool("save_customer_profile_field", JSON.stringify({ field: "dislikes", value: ["vanilla"] }), ctx);
      await executeFragranceTool("generate_new_product_combinations", "{}", ctx);

      const result = await executeFragranceTool(
        "refine_combination_recommendations",
        JSON.stringify({ feedback: "dont want sandalwood" }),
        ctx,
      );
      expect(result.modelContent).not.toMatch(/^Error/);

      const profile = await getCustomerProfile(conversationId);
      // The customer's ORIGINAL stated dislike survives — this is additive, never a replacement.
      expect(profile.dislikes).toContain("vanilla");
      // And the refinement's own literal note is now a real, persisted part of the profile.
      expect(profile.dislikes).toContain("sandalwood");
    } finally {
      await prisma.customerProfileState.deleteMany({ where: { conversationId } });
    }
  }, 60000);

  it("never touches the stored profile when the feedback carries no recognizable like/dislike at all", async () => {
    const conversationId = freshConversationId("refine-persist-noop");
    const ctx = { conversationId, customerName: "Test Customer", customerEmail: "test@example.com" };
    try {
      await verifyLosAngelesWithoutNetwork(conversationId);
      await executeFragranceTool("save_customer_profile_field", JSON.stringify({ field: "likes", value: ["Fruity"] }), ctx);
      await executeFragranceTool("generate_new_product_combinations", "{}", ctx);

      await executeFragranceTool(
        "refine_combination_recommendations",
        JSON.stringify({ feedback: "give me a Hybrid only" }),
        ctx,
      );

      const profile = await getCustomerProfile(conversationId);
      expect(profile.likes).toEqual(["Fruity"]);
      expect(profile.dislikes).toEqual([]);
    } finally {
      await prisma.customerProfileState.deleteMany({ where: { conversationId } });
    }
  }, 60000);
});

describe("select_recommendation — legacy DB rehydration (Test 3, Fix 8)", () => {
  it("resolves a bare numeric selection from the database when in-memory scratch was never populated for this conversation", async () => {
    const conversationId = freshConversationId("legacy-select");
    const profile = {
      city: "Los Angeles", stateRegion: "California", country: "United States",
      likes: ["Fruity"], dislikes: [],
    };
    const combo = (title) => ({
      type: "HYBRID",
      internalProducts: [{ title, contribution: "Freshness", notes: ["Bergamot", "Musk"] }, { title: `${title} B`, contribution: "Sweetness", notes: ["Vanilla"] }],
      recommendedRatio: [{ productTitle: title, ratioPercent: 50 }, { productTitle: `${title} B`, ratioPercent: 50 }],
      customerFacingName: `${title} Blend`,
    });
    let firstId, secondId;
    try {
      firstId = await saveRecommendation({ conversationId, profile, combination: combo("Alpha") });
      secondId = await saveRecommendation({ conversationId, profile, combination: combo("Beta") });

      // No generate_new_product_combinations/select_recommendation call has happened yet for this
      // conversationId in this process — in-memory scratch is genuinely empty, exactly like a
      // server restart would leave it for a real legacy conversation.
      const result = await executeFragranceTool(
        "select_recommendation",
        JSON.stringify({ selectionText: "2" }),
        { conversationId, customerName: "Test", customerEmail: "test@example.com" },
      );

      expect(result.modelContent).not.toMatch(/^Error/);
      expect(result.sseEvent.recommendationId).toBe(secondId);
    } finally {
      await prisma.customerProfileState.deleteMany({ where: { conversationId } });
    }
  }, 60000);
});

// confirmRecommendation re-verifies every component against the REAL FragranceProduct catalog
// (product must actually exist, must have real notes) — a synthetic/fake title always fails that
// check, so these fixtures use real catalog products, same discipline as aniqRegression.test.js.
const REAL_PAIR_A = { first: { title: "The Opera", notes: ["Rose", "Fruity Notes", "Ambergris", "Leather", "Nutmeg", "Cedar", "Vanilla", "Musk"] }, second: { title: "Water of Arabia", notes: ["Mandarin", "Bergamot", "Blackcurrant", "Green Tea", "Sandalwood"] } };
const REAL_PAIR_B = { first: { title: "Arabian Amber Nuit", notes: ["Amber", "Rose", "Grapefruit", "Bergamot", "Pink Pepper"] }, second: { title: "Leather Oud", notes: ["Leather", "Suede", "Raspberry", "Amber"] } };

function realCombo(pair) {
  return {
    type: "HYBRID",
    internalProducts: [
      { title: pair.first.title, contribution: "Freshness", notes: pair.first.notes },
      { title: pair.second.title, contribution: "Sweetness", notes: pair.second.notes },
    ],
    recommendedRatio: [
      { productTitle: pair.first.title, ratioPercent: 50 },
      { productTitle: pair.second.title, ratioPercent: 50 },
    ],
    customerFacingName: `${pair.first.title} x ${pair.second.title}`,
  };
}

describe("resolveLegacyPreviewShortCircuit — deterministic recovery for a stuck conversation (Test 3/4, Fix 8)", () => {
  it("resolves a bare '1' against the most recent pending recommendation batch and confirms it", async () => {
    const conversationId = freshConversationId("shortcircuit-numeric");
    const profile = { city: "Los Angeles", stateRegion: "California", country: "United States", likes: ["Fruity"], dislikes: [] };
    let firstId;
    try {
      firstId = await saveRecommendation({ conversationId, profile, combination: realCombo(REAL_PAIR_A) });
      await saveRecommendation({ conversationId, profile, combination: realCombo(REAL_PAIR_B) });

      const result = await resolveLegacyPreviewShortCircuit(conversationId, "1", "Test", "test@example.com");
      expect(result).toBeTruthy();
      expect(result.recommendationId).toBe(firstId);
      expect(result.previewUrl).toBe(buildPreviewUrl(firstId));

      const record = await prisma.fragranceRecommendation.findUnique({ where: { id: firstId } });
      expect(record.status).toBe("confirmed");
    } finally {
      await prisma.customerProfileState.deleteMany({ where: { conversationId } });
    }
  }, 60000);

  it("treats a bare 'preview' as re-opening an already-confirmed recommendation, not an error", async () => {
    const conversationId = freshConversationId("shortcircuit-preview");
    const profile = { city: "Los Angeles", stateRegion: "California", country: "United States", likes: ["Fruity"], dislikes: [] };
    let recId;
    try {
      recId = await saveRecommendation({ conversationId, profile, combination: realCombo(REAL_PAIR_A) });
      const first = await resolveLegacyPreviewShortCircuit(conversationId, "preview", "Test", "test@example.com");
      expect(first.recommendationId).toBe(recId);

      // Simulates the exact reported bug: the redirect never fired the first time, so the
      // customer sends "preview" again — this must still resolve, not error just because the
      // recommendation is already confirmed.
      const second = await resolveLegacyPreviewShortCircuit(conversationId, "preview", "Test", "test@example.com");
      expect(second).toBeTruthy();
      expect(second.recommendationId).toBe(recId);
    } finally {
      await prisma.customerProfileState.deleteMany({ where: { conversationId } });
    }
  }, 60000);

  it("returns null for ordinary conversational text — never hijacks a normal reply", async () => {
    const conversationId = freshConversationId("shortcircuit-noop");
    const result = await resolveLegacyPreviewShortCircuit(conversationId, "I'd like something fresh and citrusy", "Test", "test@example.com");
    expect(result).toBeNull();
  });
});
