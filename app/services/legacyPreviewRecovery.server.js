// Fix 8 (legacy conversation recovery) — a conversation that predates the auto-preview flow can
// already have a numbered list of combinations in its history, with the customer typing "1",
// "preview", "yes", etc. expecting a redirect. Relying on the model to reliably call
// select_recommendation then confirm_product_combination for a low-signal message like "1" is
// exactly the failure mode that caused the original bug — this resolves it deterministically,
// entirely bypassing the model, before callAI ever runs in app/routes/chat.jsx. Returns null (falls
// through to the normal callAI conversational flow) when the message doesn't look like a legacy
// selection/confirmation at all, or nothing can be resolved for it.
//
// Lives in its own .server.js file (rather than inline in chat.jsx) so it can be a normal named
// export: a route file's non-loader/action exports get bundled for the CLIENT too, and this
// function's Prisma/db.server dependency broke that client build the moment it was exported
// directly from chat.jsx — a plain "*.server.js" service file is what every other server-only
// piece of this codebase already uses, and React Router excludes those from the client bundle
// regardless of what they export.
import prisma from "../db.server.js";
import { getCustomerProfile, saveCustomerProfileFields } from "./customerProfile.server.js";
import { confirmRecommendation } from "./recommendationConfirmation.server.js";

const LEGACY_SELECTION_PATTERN = /^\s*(\d{1,2}|first|second|third|last|preview|yes|confirm|create it|create this|create that one)\s*[.!]?\s*$/i;

export async function resolveLegacyPreviewShortCircuit(conversationId, userMessage, customerName, customerEmail) {
  if (!LEGACY_SELECTION_PATTERN.test(userMessage || "")) return null;

  const profile = await getCustomerProfile(conversationId);
  let recommendationId = profile.selectedRecommendationId;

  if (!recommendationId) {
    const digitMatch = userMessage.match(/\d{1,2}/);
    const candidates = await prisma.fragranceRecommendation.findMany({
      where: { conversationId, status: { in: ["pending", "confirmed"] } },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    const rankOrdered = candidates.slice().reverse(); // oldest-of-the-batch first == rank order
    if (!rankOrdered.length) return null;

    if (digitMatch) {
      const idx = parseInt(digitMatch[0], 10) - 1;
      recommendationId = rankOrdered[idx]?.id || null;
    } else if (/^\s*first\s*[.!]?\s*$/i.test(userMessage)) {
      recommendationId = rankOrdered[0].id;
    } else if (/^\s*(second)\s*[.!]?\s*$/i.test(userMessage)) {
      recommendationId = rankOrdered[1]?.id || null;
    } else if (/^\s*(third)\s*[.!]?\s*$/i.test(userMessage)) {
      recommendationId = rankOrdered[2]?.id || null;
    } else if (/^\s*last\s*[.!]?\s*$/i.test(userMessage)) {
      recommendationId = rankOrdered[rankOrdered.length - 1].id;
    } else {
      // Bare "preview"/"yes"/"confirm"/"create it" with no explicit number and nothing already
      // selected — the most recently generated recommendation is the only reasonable target.
      recommendationId = candidates[0].id;
    }
  }
  if (!recommendationId) return null;

  const result = await confirmRecommendation({ recommendationId, customerName, customerEmail });
  // "already been confirmed" is a SUCCESS state here — the customer is very likely re-sending
  // "preview" because the redirect never fired the first time (the exact bug this fixes); the
  // preview page just needs to be (re-)opened for the recommendation that's already confirmed.
  if (!result.ok && !result.reason?.includes("already been confirmed")) return null;

  await saveCustomerProfileFields(conversationId, { selectedRecommendationId: recommendationId });
  return { recommendationId, previewUrl: `/fragrance-preview?recommendationId=${recommendationId}` };
}
