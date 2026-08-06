// Integration tests against the real dev database — exercises confirmRecommendation's
// deterministic re-verification gates (Phase 10) directly, without needing a live OpenAI call.
import { describe, it, expect, afterEach } from "vitest";
import prisma from "../db.server.js";
import { saveRecommendation, confirmRecommendation, getRecommendation } from "./recommendationConfirmation.server.js";

const createdRecommendationIds = [];
afterEach(async () => {
  if (createdRecommendationIds.length) {
    await prisma.fragranceRecommendation.deleteMany({ where: { id: { in: createdRecommendationIds } } });
    createdRecommendationIds.length = 0;
  }
});

// A minimal, real ProposedCombination-shaped object using two products actually present in the
// FragranceProduct catalog ("The Opera" was confirmed present during Stage A ingestion) — the
// component-existence check in confirmRecommendation queries the real catalog, so a fake title
// would always fail for the wrong reason. Explicitly excludes titles containing "vitest" — other
// test files (e.g. scripts/import-inspirations.test.js) create and delete their own throwaway
// FragranceProduct rows using that marker, and Vitest runs test files concurrently by default;
// without this exclusion, findFirst() here could pick up one of those rows and then find it
// deleted out from under it moments later by the other file's own cleanup — a real, verified
// cross-test-file race, not a bug in confirmRecommendation itself.
async function baseCombination() {
  const realProduct = await prisma.fragranceProduct.findFirst({
    where: { notesJson: { not: null }, NOT: { title: { contains: "vitest" } } },
    select: { title: true, notesJson: true },
  });
  const realProduct2 = await prisma.fragranceProduct.findFirst({
    where: { notesJson: { not: null }, NOT: [{ title: realProduct.title }, { title: { contains: "vitest" } }] },
    select: { title: true, notesJson: true },
  });
  return {
    type: "HYBRID",
    canonicalKey: `vitest-fake-key-${Date.now()}-${Math.random()}`,
    internalProducts: [
      { title: realProduct.title, notes: realProduct.notesJson, fragranceFamily: null, contribution: "Freshness" },
      { title: realProduct2.title, notes: realProduct2.notesJson, fragranceFamily: null, contribution: "Sweetness" },
    ],
    recommendedRatio: [
      { productTitle: realProduct.title, parts: 1, ratioPercent: 50, milliliters: 17 },
      { productTitle: realProduct2.title, parts: 1, ratioPercent: 50, milliliters: 17 },
    ],
    preferenceScore: 5, seasonalScore: 4, historyScore: 5, compatibilityScore: 5, balanceScore: 10,
    conflictPenalty: 0, finalScore: 29, confidence: "high", evidenceScope: "limited",
    compatibilityReasons: [], historicalEvidence: {}, analogousExistingCombinations: [], risks: [],
    customerFacingName: "Test Blend", customerFacingDescription: "test", customerFacingWhySuits: "test",
    customerFacingBestUse: "test", customerFacingWeatherSuitability: "test", customerFacingStrength: "moderate",
    customerFacingRisk: null,
  };
}

async function saveTestRecommendation(overrides = {}) {
  const combination = { ...(await baseCombination()), ...overrides };
  const id = await saveRecommendation({
    conversationId: "vitest-confirm-" + Date.now(),
    profile: { dislikes: [] },
    combination,
  });
  createdRecommendationIds.push(id);
  return id;
}

describe("confirmRecommendation", () => {
  it("succeeds for a fresh, valid recommendation with a real customer name/email", async () => {
    const id = await saveTestRecommendation();
    const result = await confirmRecommendation({ recommendationId: id, customerName: "Test Customer", customerEmail: "test@example.com" });
    expect(result.ok).toBe(true);
    expect(result.recommendation.status).toBe("confirmed");
  });

  it("rejects a recommendation that doesn't exist", async () => {
    const result = await confirmRecommendation({ recommendationId: "nonexistent-id", customerName: "X", customerEmail: "x@example.com" });
    expect(result).toEqual({ ok: false, reason: "Recommendation not found." });
  });

  it("rejects confirming the same recommendation twice", async () => {
    const id = await saveTestRecommendation();
    await confirmRecommendation({ recommendationId: id, customerName: "Test Customer", customerEmail: "test@example.com" });
    const second = await confirmRecommendation({ recommendationId: id, customerName: "Test Customer", customerEmail: "test@example.com" });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/already been confirmed/);
  });

  it("rejects when customer name or email is missing (Shopify account data required)", async () => {
    const id = await saveTestRecommendation();
    const result = await confirmRecommendation({ recommendationId: id, customerName: null, customerEmail: null });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Customer name and email/);
  });

  // Fix 4 — saveRecommendation itself now runs the same hard shape gate as generation time
  // (defense in depth): a bad-ratio combination can never even be PERSISTED, let alone reach
  // confirmation.
  it("saveRecommendation itself rejects ratios that don't sum to 100% (Fix 4 defense-in-depth)", async () => {
    const combination = await baseCombination();
    combination.recommendedRatio = combination.recommendedRatio.map((r) => ({ ...r, ratioPercent: 40 })); // 80% total
    await expect(
      saveRecommendation({ conversationId: "vitest-confirm-badratio-" + Date.now(), profile: { dislikes: [] }, combination }),
    ).rejects.toThrow(/sum to 100/);
  });

  it("confirmRecommendation independently re-checks ratios even for a row that bypassed saveRecommendation", async () => {
    const combination = await baseCombination();
    const record = await prisma.fragranceRecommendation.create({
      data: {
        conversationId: "vitest-confirm-badratio-direct-" + Date.now(),
        customerProfileJson: { dislikes: [] },
        productsJson: combination.internalProducts,
        combinationType: combination.type,
        scoreJson: {},
        evidenceJson: { canonicalKey: combination.canonicalKey },
        ratiosJson: combination.recommendedRatio.map((r) => ({ ...r, ratioPercent: 40 })), // 80% total
        status: "pending",
      },
    });
    createdRecommendationIds.push(record.id);

    const result = await confirmRecommendation({ recommendationId: record.id, customerName: "Test Customer", customerEmail: "test@example.com" });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Ratios sum to/);
  });

  it("rejects an expired recommendation and marks it expired", async () => {
    const combination = await baseCombination();
    const record = await prisma.fragranceRecommendation.create({
      data: {
        conversationId: "vitest-confirm-expired-" + Date.now(),
        customerProfileJson: { dislikes: [] },
        productsJson: combination.internalProducts,
        combinationType: combination.type,
        scoreJson: {},
        evidenceJson: { canonicalKey: combination.canonicalKey },
        ratiosJson: combination.recommendedRatio,
        status: "pending",
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // 48h ago — past the 24h window
      },
    });
    createdRecommendationIds.push(record.id);

    const result = await confirmRecommendation({ recommendationId: record.id, customerName: "Test Customer", customerEmail: "test@example.com" });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expired/);

    const reloaded = await getRecommendation(record.id);
    expect(reloaded.status).toBe("expired");
  });

  it("rejects when a component product has a high-severity conflict with the customer's dislikes", async () => {
    const combination = await baseCombination();
    // Force a real, unambiguous high conflict: 3+ strongHeavy notes on one component.
    combination.internalProducts[0].notes = ["Oud", "Leather", "Tobacco", "Resin"];
    const id = await saveRecommendation({
      conversationId: "vitest-confirm-conflict-" + Date.now(),
      profile: { dislikes: ["Strong"] },
      combination,
    });
    createdRecommendationIds.push(id);

    const result = await confirmRecommendation({ recommendationId: id, customerName: "Test Customer", customerEmail: "test@example.com" });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/high-severity conflict/);
  });
});

// Fix (no deduplication) — confirmed as a real gap: nothing stopped the exact same component
// signature from being persisted twice for one active conversation (e.g. two generation calls
// both scoring the same top candidate identically), each with its own id and its own name.
describe("saveRecommendation deduplication (Phase 16)", () => {
  it("reuses the existing recommendation instead of creating a duplicate for the same conversation + component signature", async () => {
    const conversationId = "vitest-dedup-" + Date.now();
    const combination = await baseCombination();
    const firstId = await saveRecommendation({ conversationId, profile: { dislikes: [] }, combination });
    createdRecommendationIds.push(firstId);

    const secondId = await saveRecommendation({ conversationId, profile: { dislikes: [] }, combination });
    expect(secondId).toBe(firstId);

    const rows = await prisma.fragranceRecommendation.findMany({ where: { conversationId }, select: { evidenceJson: true } });
    const count = rows.filter((r) => r.evidenceJson?.canonicalKey === combination.canonicalKey).length;
    expect(count).toBe(1);
  });

  it("does NOT dedupe across different conversations, even with the same component signature", async () => {
    const combination = await baseCombination();
    const firstId = await saveRecommendation({ conversationId: "vitest-dedup-a-" + Date.now(), profile: { dislikes: [] }, combination });
    createdRecommendationIds.push(firstId);
    const secondId = await saveRecommendation({ conversationId: "vitest-dedup-b-" + Date.now(), profile: { dislikes: [] }, combination });
    createdRecommendationIds.push(secondId);
    expect(secondId).not.toBe(firstId);
  });

  it("does NOT dedupe against an expired recommendation — a fresh one is created instead", async () => {
    const combination = await baseCombination();
    const conversationId = "vitest-dedup-expired-" + Date.now();
    const old = await prisma.fragranceRecommendation.create({
      data: {
        conversationId,
        customerProfileJson: { dislikes: [] },
        productsJson: combination.internalProducts,
        combinationType: combination.type,
        scoreJson: {},
        evidenceJson: { canonicalKey: combination.canonicalKey },
        ratiosJson: combination.recommendedRatio,
        status: "pending",
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // 48h ago — past the 24h window
      },
    });
    createdRecommendationIds.push(old.id);

    const freshId = await saveRecommendation({ conversationId, profile: { dislikes: [] }, combination });
    createdRecommendationIds.push(freshId);
    expect(freshId).not.toBe(old.id);
  });
});
