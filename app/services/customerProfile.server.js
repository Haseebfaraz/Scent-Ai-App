// Phase 1 — CustomerFragranceProfile state, stored separately from raw conversation history and
// validated by the backend rather than left to the model's own memory of "which turn am I on."
// Backs the save_customer_profile_field / get_customer_profile tools.
import prisma from "../db.server.js";

export const VALID_SEASONS = ["Winter", "Spring", "Summer", "Fall"];
export const VALID_STRENGTH_PREFERENCES = ["light", "moderate", "strong"];

// Every field the spec's CustomerFragranceProfile type declares. name/email are expected to come
// from the authenticated Shopify account (see chat.jsx's knownCustomerEmail/knownCustomerName) —
// stored here too so a full profile snapshot can be embedded in FragranceRecommendation.
export function emptyProfile() {
  return {
    name: null,
    email: null,
    city: null,
    stateRegion: null,
    country: null,
    season: null,
    likes: [],
    dislikes: [],
    preferredStyle: null,
    occasion: null,
    strengthPreference: null,
    additionalPreferences: [],
  };
}

export async function getCustomerProfile(conversationId) {
  const row = await prisma.customerProfileState.findUnique({ where: { conversationId } });
  return row ? { ...emptyProfile(), ...row.profileJson } : emptyProfile();
}

/**
 * @param {string} conversationId
 * @param {string} field - a key of CustomerFragranceProfile.
 * @param {*} value
 * @returns {Promise<object>} the full updated profile.
 */
export async function saveCustomerProfileField(conversationId, field, value) {
  const current = await getCustomerProfile(conversationId);
  if (!(field in current)) {
    throw new Error(`Unknown CustomerFragranceProfile field: "${field}"`);
  }
  const updated = { ...current, [field]: value };
  await prisma.customerProfileState.upsert({
    where: { conversationId },
    update: { profileJson: updated },
    create: { conversationId, profileJson: updated },
  });
  return updated;
}

// Spec: "Required fields before analysis: City, Country, Season, At least one like or preferred
// style. Dislikes may be empty."
export function getMissingRequiredFields(profile) {
  const missing = [];
  if (!profile.city) missing.push("city");
  if (!profile.country) missing.push("country");
  if (!profile.season) missing.push("season");
  if (!(profile.likes?.length > 0) && !profile.preferredStyle) missing.push("likes or preferredStyle");
  return missing;
}

export function isProfileReadyForAnalysis(profile) {
  return getMissingRequiredFields(profile).length === 0;
}
