// Regression tests for the auto-preview-flow fix — the customer must never see a "pick one of
// five" screen and must never need to type "1"/"yes"/"preview" for a NEW recommendation; the
// backend deterministically selects and confirms the best one and emits preview_ready on its own.
// generate_new_product_combinations/select_recommendation/confirmRecommendation are all pure
// backend logic (no OpenAI call inside them — only chat.jsx's callAI() calls OpenAI), so this
// exercises the real fix directly against the real catalog/database, the same pattern
// aniqRegression.test.js already uses.
import { describe, it, expect } from "vitest";
import { executeFragranceTool } from "../tools/fragranceAgentTools.server.js";
import { saveRecommendation } from "./recommendationConfirmation.server.js";
import { resolveLegacyPreviewShortCircuit } from "./legacyPreviewRecovery.server.js";
import prisma from "../db.server.js";

function freshConversationId(label) {
  return `vitest-autopreview-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("generate_new_product_combinations — auto-select + auto-confirm (Test 1/2)", () => {
  it("emits preview_ready for the best recommendation instead of a combination list, with no customer input needed", async () => {
    const conversationId = freshConversationId("best");
    const ctx = { conversationId, customerName: "Test Customer", customerEmail: "test@example.com" };
    try {
      await executeFragranceTool("verify_customer_location", JSON.stringify({ cityText: "Los Angeles" }), ctx);
      await executeFragranceTool("save_customer_profile_field", JSON.stringify({ field: "likes", value: ["Fruity"] }), ctx);

      const result = await executeFragranceTool("generate_new_product_combinations", "{}", ctx);

      expect(result.modelContent).not.toMatch(/^Error/);
      expect(result.sseEvent).toBeTruthy();
      expect(result.sseEvent.type).toBe("preview_ready");
      expect(result.sseEvent.recommendationId).toBeTruthy();
      expect(result.sseEvent.previewUrl).toBe(`/fragrance-preview?recommendationId=${result.sseEvent.recommendationId}`);

      // The customer must never be shown a list to pick from — this event type is retired for
      // the auto-preview success path.
      expect(result.sseEvent.type).not.toBe("combination_recommendations");

      // The recommendation really is confirmed in the database, not just narrated as if it were.
      const record = await prisma.fragranceRecommendation.findUnique({ where: { id: result.sseEvent.recommendationId } });
      expect(record.status).toBe("confirmed");
    } finally {
      await prisma.customerProfileState.deleteMany({ where: { conversationId } });
    }
  }, 30000);

  it("tells the model explicitly not to list combinations or ask the customer to pick one", async () => {
    const conversationId = freshConversationId("instruction");
    const ctx = { conversationId, customerName: "Test Customer", customerEmail: "test@example.com" };
    try {
      await executeFragranceTool("verify_customer_location", JSON.stringify({ cityText: "Los Angeles" }), ctx);
      await executeFragranceTool("save_customer_profile_field", JSON.stringify({ field: "likes", value: ["Fruity"] }), ctx);

      const result = await executeFragranceTool("generate_new_product_combinations", "{}", ctx);
      expect(result.modelContent).toMatch(/do not list|do not ask/i);
    } finally {
      await prisma.customerProfileState.deleteMany({ where: { conversationId } });
    }
  }, 30000);
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
  }, 30000);
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
      expect(result.previewUrl).toBe(`/fragrance-preview?recommendationId=${firstId}`);

      const record = await prisma.fragranceRecommendation.findUnique({ where: { id: firstId } });
      expect(record.status).toBe("confirmed");
    } finally {
      await prisma.customerProfileState.deleteMany({ where: { conversationId } });
    }
  }, 30000);

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
  }, 30000);

  it("returns null for ordinary conversational text — never hijacks a normal reply", async () => {
    const conversationId = freshConversationId("shortcircuit-noop");
    const result = await resolveLegacyPreviewShortCircuit(conversationId, "I'd like something fresh and citrusy", "Test", "test@example.com");
    expect(result).toBeNull();
  });
});
