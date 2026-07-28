// Phase 1 — CustomerFragranceProfile state, stored separately from raw conversation history and
// validated by the backend rather than left to the model's own memory of "which turn am I on."
// Backs the save_customer_profile_field / get_customer_profile tools.
//
// Fix 1/8 (real transcript bug): a customer-requested season STYLE and the real live weather are
// two SEPARATE concepts that must never be confused or silently overwritten — the "I've saved that
// it's summer" bug happened because nothing distinguished "the customer said Winter" from "the
// calendar thinks it's Summer" from "the weather looks warm." `weatherDirection` is fully
// automatic: derived and saved the moment a city is verified, never asked about, never customer-
// facing as a question. `requestedSeasonStyle` is written ONLY by an explicit customer statement
// of style ("I want something wintery") — never inferred, never defaulted. The calendar-inferred
// season (app/utils/weatherSeason.js) is NEVER persisted here at all, so it structurally cannot
// overwrite anything.
import prisma from "../db.server.js";

export const VALID_SEASONS = ["Winter", "Spring", "Summer", "Fall"];
export const VALID_STRENGTH_PREFERENCES = ["light", "moderate", "strong"];
export const VALID_WEATHER_DIRECTIONS = ["hot", "warm", "mild", "cool", "cold", "humid", "rainy"];
export const VALID_LOCATION_SOURCES = ["geocoding", "order_history", "customer_confirmed"];

export function emptyProfile() {
  return {
    name: null,
    email: null,
    city: null,
    stateRegion: null,
    country: null,
    // A customer-requested season STYLE, e.g. "I want something wintery" — set ONLY when the
    // customer volunteers one, never asked for, never defaulted from weather or calendar.
    requestedSeasonStyle: null,
    // Set exactly once, the first time a real requestedSeasonStyle/live-weather mismatch is
    // surfaced and the customer picks a resolution — prevents ever asking about the same conflict
    // twice.
    seasonStyleConflictResolved: false,
    currentWeather: {
      condition: null, // e.g. "mild and sunny" — simple customer-facing words, never raw WMO codes.
      temperatureC: null,
      fetchedAt: null, // ISO string
    },
    // Automatic, deterministic climate direction derived the moment a city is verified — the
    // default basis for a recommendation whenever the customer hasn't requested a specific style.
    weatherDirection: null,
    weatherLocation: {
      city: null,
      country: null,
      verified: false,
    },
    likes: [],
    dislikes: [],
    preferredStyle: null,
    occasion: null,
    strengthPreference: null,
    additionalPreferences: [],
    // Location verification is intentionally separate from the plain `city`/`country` fields —
    // those can be set the moment a customer types something, but `locationVerified` only ever
    // becomes true as the deterministic result of verify_customer_location (real geocoding or a
    // real order-history match), never just because the model or customer said a word.
    locationVerified: false,
    locationSource: null,
    // The one recommendation the customer has actually picked, by ID — set only by the
    // select_recommendation tool's deterministic parser, never reconstructed by the model from
    // conversation text. Immutable once set except by another explicit selection (Fix 7).
    selectedRecommendationId: null,
  };
}

export async function getCustomerProfile(conversationId) {
  const row = await prisma.customerProfileState.findUnique({ where: { conversationId } });
  if (!row) return emptyProfile();
  // Deep-merge one level for the two nested objects so a profile saved before these fields existed
  // (or a partial field update) still gets real defaults instead of `undefined`.
  const empty = emptyProfile();
  return {
    ...empty,
    ...row.profileJson,
    currentWeather: { ...empty.currentWeather, ...(row.profileJson.currentWeather || {}) },
    weatherLocation: { ...empty.weatherLocation, ...(row.profileJson.weatherLocation || {}) },
  };
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

/**
 * Persists several fields atomically (one upsert instead of N sequential saveCustomerProfileField
 * calls) — used by deterministic tool handlers (verify_customer_location, resolve_season_preference,
 * select_recommendation) that always update a known, fixed set of fields together as one real
 * state transition, never individually field-by-field.
 * @param {string} conversationId
 * @param {object} fields - partial profile fields to merge in.
 * @returns {Promise<object>} the full updated profile.
 */
export async function saveCustomerProfileFields(conversationId, fields) {
  const current = await getCustomerProfile(conversationId);
  for (const field of Object.keys(fields)) {
    if (!(field in current)) {
      throw new Error(`Unknown CustomerFragranceProfile field: "${field}"`);
    }
  }
  const updated = { ...current, ...fields };
  await prisma.customerProfileState.upsert({
    where: { conversationId },
    update: { profileJson: updated },
    create: { conversationId, profileJson: updated },
  });
  return updated;
}

// Spec: "Required fields before analysis: City, Country, At least one like or preferred style.
// Dislikes may be empty." City must additionally be VERIFIED, not just present as text — per Fix 8,
// an unverified city (e.g. a fictional one the model accepted) must not let analysis proceed as if
// it were real. Season is intentionally NOT a required field here: weatherDirection is populated
// automatically the moment the city is verified (see verify_customer_location), so there is never
// a real gap to block on — requestedSeasonStyle, when present, only refines the direction further.
export function getMissingRequiredFields(profile) {
  const missing = [];
  if (!profile.city || !profile.locationVerified) missing.push("city");
  if (!profile.country) missing.push("country");
  if (!(profile.likes?.length > 0) && !profile.preferredStyle) missing.push("likes or preferredStyle");
  return missing;
}

export function isProfileReadyForAnalysis(profile) {
  return getMissingRequiredFields(profile).length === 0;
}
