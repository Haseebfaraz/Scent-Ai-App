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
  it("requires city, country, season, and likes-or-preferredStyle", () => {
    expect(getMissingRequiredFields(emptyProfile())).toEqual(["city", "country", "season", "likes or preferredStyle"]);
    expect(isProfileReadyForAnalysis(emptyProfile())).toBe(false);
  });

  it("is satisfied once all required fields are present", () => {
    const profile = { ...emptyProfile(), city: "Los Angeles", country: "United States", season: "Summer", likes: ["Fruity"] };
    expect(getMissingRequiredFields(profile)).toEqual([]);
    expect(isProfileReadyForAnalysis(profile)).toBe(true);
  });

  it("accepts preferredStyle in place of likes", () => {
    const profile = { ...emptyProfile(), city: "Los Angeles", country: "United States", season: "Summer", preferredStyle: "warm and woody" };
    expect(isProfileReadyForAnalysis(profile)).toBe(true);
  });

  it("dislikes being empty never blocks readiness", () => {
    const profile = { ...emptyProfile(), city: "A", country: "B", season: "Summer", likes: ["Fruity"], dislikes: [] };
    expect(isProfileReadyForAnalysis(profile)).toBe(true);
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
