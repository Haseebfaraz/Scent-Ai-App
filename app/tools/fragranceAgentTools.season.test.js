// Integration tests against the real dev database — exercises the season/weather v2 flow
// (verify_customer_location auto-fetching weather, requestedSeasonStyle conflict handling) end to
// end through executeFragranceTool, matching this project's real-DB testing convention. Fix (test
// reliability): the external Open-Meteo geocoding/weather API is mocked via global.fetch — the
// real DB reads/writes (CustomerProfileState) are untouched and still exercised for real.
import { describe, it, expect, afterEach, vi } from "vitest";
import prisma from "../db.server.js";
import { executeFragranceTool } from "./fragranceAgentTools.server.js";
import { getCustomerProfile } from "../services/customerProfile.server.js";

const testConversationIds = [];
function newConversationId() {
  const id = `vitest-season-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  testConversationIds.push(id);
  return id;
}

const originalFetch = global.fetch;
afterEach(async () => {
  await prisma.customerProfileState.deleteMany({ where: { conversationId: { in: testConversationIds } } });
  testConversationIds.length = 0;
  global.fetch = originalFetch;
});

const ctx = (conversationId) => ({ conversationId, customerName: "Test Customer", customerEmail: "test@example.com" });

function mockGeocodeResponse(results) {
  return { ok: true, json: async () => ({ results }) };
}
// verify_customer_location calls geocodePlace (for weather) potentially twice per real flow
// (verifyCity's own geocoding fallback, then fetchCurrentWeather's own geocode-for-coordinates
// call) — Los Angeles resolves via the fast order-history DB path first, so only the weather
// forecast call actually needs a real network response mocked for that city.
function mockLosAngelesWeather(fetchMock, { tempF = 75, weatherCode = 1, humidity = 50 } = {}) {
  fetchMock
    .mockResolvedValueOnce(mockGeocodeResponse([{ name: "Los Angeles", country: "United States", latitude: 34.05, longitude: -118.24 }]))
    .mockResolvedValueOnce({ ok: true, json: async () => ({ current: { temperature_2m: tempF, weather_code: weatherCode, relative_humidity_2m: humidity } }) });
}

describe("verify_customer_location auto-fetches weather (season/weather v2)", () => {
  it("saves weatherDirection and currentWeather automatically on a real, verified city — never asking about season", async () => {
    const conversationId = newConversationId();
    global.fetch = vi.fn();
    mockLosAngelesWeather(global.fetch);
    const result = await executeFragranceTool("verify_customer_location", JSON.stringify({ cityText: "Los Angeles" }), ctx(conversationId));

    expect(result.modelContent).not.toMatch(/which season/i);
    expect(result.modelContent).not.toMatch(/adjusted? accordingly|according to your weather/i);

    const profile = await getCustomerProfile(conversationId);
    expect(profile.locationVerified).toBe(true);
    expect(profile.city).toBeTruthy();
    expect(["hot", "warm", "mild", "cool", "cold", "humid", "rainy"]).toContain(profile.weatherDirection);
    expect(profile.currentWeather.condition).toBeTruthy();
  });

  it("rejects a fictional city and never populates weatherDirection", async () => {
    const conversationId = newConversationId();
    global.fetch = vi.fn(async () => mockGeocodeResponse([])); // fictional city — geocoding finds nothing
    await executeFragranceTool("verify_customer_location", JSON.stringify({ cityText: "Vice City" }), ctx(conversationId));
    const profile = await getCustomerProfile(conversationId);
    expect(profile.locationVerified).toBe(false);
    expect(profile.weatherDirection).toBeNull();
    // Extended timeout — same pre-existing full-suite DB-contention margin as
    // locationVerification.test.js's identical scenario; no live network call happens here.
  }, 90000);
});

describe("requestedSeasonStyle conflict flow", () => {
  it("does not block or complain when a style is saved with no weather on file yet", async () => {
    const conversationId = newConversationId();
    const result = await executeFragranceTool(
      "save_customer_profile_field",
      JSON.stringify({ field: "requestedSeasonStyle", value: "Winter" }),
      ctx(conversationId),
    );
    expect(result.modelContent).toMatch(/no real conflict/i);
    const profile = await getCustomerProfile(conversationId);
    expect(profile.requestedSeasonStyle).toBe("Winter");
  });

  it("flags a conflict and resolve_season_preference('keep_style') keeps the style unchanged", async () => {
    const conversationId = newConversationId();
    // Force a real weather reading via a real verified city, then manually set a conflicting
    // direction so this test doesn't depend on today's actual live weather being hot.
    global.fetch = vi.fn();
    mockLosAngelesWeather(global.fetch);
    await executeFragranceTool("verify_customer_location", JSON.stringify({ cityText: "Los Angeles" }), ctx(conversationId));
    const { saveCustomerProfileFields } = await import("../services/customerProfile.server.js");
    await saveCustomerProfileFields(conversationId, { weatherDirection: "hot" });

    const saveResult = await executeFragranceTool(
      "save_customer_profile_field",
      JSON.stringify({ field: "requestedSeasonStyle", value: "Winter" }),
      ctx(conversationId),
    );
    expect(saveResult.modelContent).toMatch(/ask the customer once/i);

    const resolveResult = await executeFragranceTool(
      "resolve_season_preference",
      JSON.stringify({ choice: "keep_style" }),
      ctx(conversationId),
    );
    expect(resolveResult.modelContent).toMatch(/keeping the requested Winter style/i);
    const profile = await getCustomerProfile(conversationId);
    expect(profile.requestedSeasonStyle).toBe("Winter");
    expect(profile.seasonStyleConflictResolved).toBe(true);
  });

  it("resolve_season_preference('use_weather') clears the requested style", async () => {
    const conversationId = newConversationId();
    global.fetch = vi.fn();
    mockLosAngelesWeather(global.fetch);
    await executeFragranceTool("verify_customer_location", JSON.stringify({ cityText: "Los Angeles" }), ctx(conversationId));
    const { saveCustomerProfileFields } = await import("../services/customerProfile.server.js");
    await saveCustomerProfileFields(conversationId, { weatherDirection: "hot", requestedSeasonStyle: "Winter" });

    await executeFragranceTool("resolve_season_preference", JSON.stringify({ choice: "use_weather" }), ctx(conversationId));
    const profile = await getCustomerProfile(conversationId);
    expect(profile.requestedSeasonStyle).toBeNull();
    expect(profile.seasonStyleConflictResolved).toBe(true);
  });
});

describe("getMissingRequiredFields never blocks on season", () => {
  it("analyze_customer_product_candidates only requires city/country/likes — never a season", async () => {
    const conversationId = newConversationId();
    global.fetch = vi.fn();
    mockLosAngelesWeather(global.fetch);
    await executeFragranceTool("verify_customer_location", JSON.stringify({ cityText: "Los Angeles" }), ctx(conversationId));
    await executeFragranceTool("save_customer_profile_field", JSON.stringify({ field: "likes", value: ["Fruity"] }), ctx(conversationId));
    const result = await executeFragranceTool("analyze_customer_product_candidates", "{}", ctx(conversationId));
    expect(result.modelContent).not.toMatch(/missing required fields/i);
  });
});
