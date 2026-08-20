// Integration tests — run against the real dev database (DATABASE_URL from .env via
// vitest.setup.js), same verification approach used throughout this project. Each test creates
// its own uniquely-named conversationId and cleans up after itself.
import { describe, it, expect, afterEach } from "vitest";
import prisma from "../db.server.js";
import {
  emptyProfile,
  getCustomerProfile,
  saveCustomerProfileField,
  getMissingRequiredFields,
  getConversationSignals,
  isProfileReadyForAnalysis,
} from "./customerProfile.server.js";

const testConversationIds = [];
function newConversationId() {
  const id = `vitest-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  testConversationIds.push(id);
  return id;
}

afterEach(async () => {
  await prisma.customerProfileState.deleteMany({ where: { conversationId: { in: testConversationIds } } });
  testConversationIds.length = 0;
});

describe("getMissingRequiredFields / isProfileReadyForAnalysis", () => {
  it("requires city, country, and likes-or-preferredStyle (season is never required — it's automatic)", () => {
    expect(getMissingRequiredFields(emptyProfile())).toEqual([
      "city", "country", "likes or preferredStyle",
    ]);
    expect(isProfileReadyForAnalysis(emptyProfile())).toBe(false);
  });

  it("is satisfied once all required fields are present, with no requestedSeasonStyle at all", () => {
    const profile = {
      ...emptyProfile(), city: "Los Angeles", country: "United States", likes: ["Fruity"],
      locationVerified: true, dislikesAsked: true, occasionAsked: true,
    };
    expect(getMissingRequiredFields(profile)).toEqual([]);
    expect(isProfileReadyForAnalysis(profile)).toBe(true);
  });

  it("accepts preferredStyle in place of likes", () => {
    const profile = {
      ...emptyProfile(), city: "Los Angeles", country: "United States", preferredStyle: "warm and woody",
      locationVerified: true, dislikesAsked: true, occasionAsked: true,
    };
    expect(isProfileReadyForAnalysis(profile)).toBe(true);
  });

  it("dislikes being empty never blocks readiness, as long as dislikesAsked is true", () => {
    const profile = {
      ...emptyProfile(), city: "A", country: "B", likes: ["Fruity"], dislikes: [],
      locationVerified: true, dislikesAsked: true, occasionAsked: true,
    };
    expect(isProfileReadyForAnalysis(profile)).toBe(true);
  });

  // Fix (refactor: "feel human") — dislikesAsked/occasionAsked are deliberately no longer
  // hard-blocking (see getConversationSignals instead, which surfaces them informationally to the
  // model without forcing two more scripted questions regardless of conversational context).
  it("is ready as soon as city, country, and a like/style signal are present, even if dislikes/occasion were never asked", () => {
    const profile = {
      ...emptyProfile(), city: "Los Angeles", country: "United States", likes: ["Fruity"], locationVerified: true,
    };
    expect(getMissingRequiredFields(profile)).toEqual([]);
    expect(isProfileReadyForAnalysis(profile)).toBe(true);
  });

  // Fix 8 — a city string alone (however plausible, e.g. a fictional "Vice City") must never
  // satisfy readiness; only a deterministically VERIFIED city can.
  it("a city that hasn't been verified still blocks readiness, even with everything else present", () => {
    const profile = {
      ...emptyProfile(), city: "Vice City", country: "United States", likes: ["Fruity"], locationVerified: false,
      dislikesAsked: true, occasionAsked: true,
    };
    expect(getMissingRequiredFields(profile)).toEqual(["city"]);
    expect(isProfileReadyForAnalysis(profile)).toBe(false);
  });
});

describe("getConversationSignals", () => {
  it("reports dislikesAsked/occasionAsked informationally, never as a blocker", () => {
    expect(getConversationSignals(emptyProfile())).toEqual({ dislikesAsked: false, occasionAsked: false });
    expect(getConversationSignals({ ...emptyProfile(), dislikesAsked: true, occasionAsked: true }))
      .toEqual({ dislikesAsked: true, occasionAsked: true });
  });
});

describe("getCustomerProfile / saveCustomerProfileField (real DB)", () => {
  it("returns an empty profile for an unseen conversation", async () => {
    const profile = await getCustomerProfile(newConversationId());
    expect(profile).toEqual(emptyProfile());
  });

  it("persists a field and rehydrates it correctly", async () => {
    const conversationId = newConversationId();
    await saveCustomerProfileField(conversationId, "city", "Los Angeles");
    await saveCustomerProfileField(conversationId, "likes", ["Fruity", "Sweet"]);

    const reread = await getCustomerProfile(conversationId);
    expect(reread.city).toBe("Los Angeles");
    expect(reread.likes).toEqual(["Fruity", "Sweet"]);
  });

  it("rejects an unknown profile field", async () => {
    await expect(saveCustomerProfileField(newConversationId(), "notARealField", "x")).rejects.toThrow(/Unknown CustomerFragranceProfile field/);
  });
});
