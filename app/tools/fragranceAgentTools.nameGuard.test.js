// Regression test for the mood/filler-reply-saved-as-name bug — confirmed live: a customer's reply
// to "What should I call you?" ("not having a great day") got saved verbatim as their name. The
// prompt already says "if it doesn't look like a real name, gently clarify instead of guessing," but
// that's advisory only, so this is a real backend gate at the save_customer_profile_field tool.
import { describe, it, expect, afterEach } from "vitest";
import prisma from "../db.server.js";
import { executeFragranceTool } from "./fragranceAgentTools.server.js";
import { getCustomerProfile } from "../services/customerProfile.server.js";

const testConversationIds = [];
function newConversationId() {
  const id = `vitest-nameguard-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  testConversationIds.push(id);
  return id;
}
afterEach(async () => {
  await prisma.customerProfileState.deleteMany({ where: { conversationId: { in: testConversationIds } } });
  testConversationIds.length = 0;
});

// customerName must be null/undefined here — the trusted-identity check (Fix 5) short-circuits
// before this guard ever runs if the backend already has a trusted name for the conversation.
const ctx = (conversationId) => ({ conversationId, customerName: null, customerEmail: "test@example.com" });

describe("save_customer_profile_field name guard", () => {
  it("rejects a mood/filler reply and never saves it as the name", async () => {
    const conversationId = newConversationId();
    const result = await executeFragranceTool(
      "save_customer_profile_field",
      JSON.stringify({ field: "name", value: "not having a great day" }),
      ctx(conversationId),
    );
    expect(result.modelContent).toMatch(/^Error/);

    const profile = await getCustomerProfile(conversationId);
    expect(profile.name).toBeNull();
  });

  it("rejects other common mood/filler replies", async () => {
    const conversationId = newConversationId();
    for (const value of ["good, how about you", "just tired today", "not bad"]) {
      const result = await executeFragranceTool(
        "save_customer_profile_field",
        JSON.stringify({ field: "name", value }),
        ctx(conversationId),
      );
      expect(result.modelContent).toMatch(/^Error/);
    }
  });

  it("still accepts a real name", async () => {
    const conversationId = newConversationId();
    const result = await executeFragranceTool(
      "save_customer_profile_field",
      JSON.stringify({ field: "name", value: "Yamel" }),
      ctx(conversationId),
    );
    expect(result.modelContent).not.toMatch(/^Error/);

    const profile = await getCustomerProfile(conversationId);
    expect(profile.name).toBe("Yamel");
  });

  it("still accepts a real two-word name", async () => {
    const conversationId = newConversationId();
    await executeFragranceTool(
      "save_customer_profile_field",
      JSON.stringify({ field: "name", value: "Micheal Smith" }),
      ctx(conversationId),
    );
    const profile = await getCustomerProfile(conversationId);
    expect(profile.name).toBe("Micheal Smith");
  });
});
