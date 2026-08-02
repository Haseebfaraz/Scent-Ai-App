// Regression test for the gift-shopping branch's new giftRecipient profile field — a customer
// indicating this is a gift (e.g. "for my husband") should have that saved and retrievable, and
// the rest of the profile (likes/dislikes/preferredStyle/occasion) is unaffected by it existing.
import { describe, it, expect, afterEach } from "vitest";
import prisma from "../db.server.js";
import { executeFragranceTool } from "./fragranceAgentTools.server.js";
import { getCustomerProfile } from "../services/customerProfile.server.js";

const testConversationIds = [];
function newConversationId() {
  const id = `vitest-giftrecipient-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  testConversationIds.push(id);
  return id;
}
afterEach(async () => {
  await prisma.customerProfileState.deleteMany({ where: { conversationId: { in: testConversationIds } } });
  testConversationIds.length = 0;
});

const ctx = (conversationId) => ({ conversationId, customerName: "Test Customer", customerEmail: "test@example.com" });

describe("giftRecipient profile field", () => {
  it("saves and persists a gift recipient label", async () => {
    const conversationId = newConversationId();
    const result = await executeFragranceTool(
      "save_customer_profile_field",
      JSON.stringify({ field: "giftRecipient", value: "husband" }),
      ctx(conversationId),
    );
    expect(result.modelContent).not.toMatch(/^Error/);

    const profile = await getCustomerProfile(conversationId);
    expect(profile.giftRecipient).toBe("husband");
  });

  it("defaults to null for a normal (non-gift) profile", async () => {
    const conversationId = newConversationId();
    const profile = await getCustomerProfile(conversationId);
    expect(profile.giftRecipient).toBeNull();
  });

  it("lets likes/dislikes/preferredStyle/occasion still save normally alongside a gift recipient", async () => {
    const conversationId = newConversationId();
    await executeFragranceTool("save_customer_profile_field", JSON.stringify({ field: "giftRecipient", value: "wife" }), ctx(conversationId));
    await executeFragranceTool("save_customer_profile_field", JSON.stringify({ field: "likes", value: ["Floral"] }), ctx(conversationId));
    await executeFragranceTool("save_customer_profile_field", JSON.stringify({ field: "occasion", value: "birthday" }), ctx(conversationId));

    const profile = await getCustomerProfile(conversationId);
    expect(profile.giftRecipient).toBe("wife");
    expect(profile.likes).toEqual(["Floral"]);
    expect(profile.occasion).toBe("birthday");
  });
});
