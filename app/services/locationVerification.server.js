// Fix 8 — a city is only ever "verified" through a real geocoding result or a real match against
// the order-history city database, NEVER just because the model accepted whatever text the
// customer typed. This directly closes the "Vice City" bug: the old flow had no verification step
// at all — any string the model wrote into save_customer_profile_field("city", ...) was treated as
// real.
import prisma from "../db.server.js";

const GEOCODE_TIMEOUT_MS = 8000;

async function geocodePlace(placeName) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?count=5&name=${encodeURIComponent(placeName)}`,
      { signal: controller.signal },
    );
    if (!res.ok) return { results: [] };
    const data = await res.json();
    return { results: Array.isArray(data.results) ? data.results : [] };
  } catch (err) {
    console.error("Geocoding request failed:", err.message);
    return { results: [], error: err.message };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * @param {string} cityText - raw customer-typed location text.
 * @returns {Promise<{
 *   verified: boolean,
 *   city: string|null,
 *   country: string|null,
 *   source: "order_history"|"geocoding"|null,
 *   needsClarification: boolean,
 *   candidates: Array<{city: string, country: string}>,
 * }>}
 */
export async function verifyCity(cityText) {
  const trimmed = (cityText || "").trim();
  if (!trimmed) {
    return { verified: false, city: null, country: null, source: null, needsClarification: false, candidates: [] };
  }

  // Fast path: an exact (case-insensitive) match against a real city already present in order
  // history — real data, no network call needed. Never REQUIRED (a real city with zero historical
  // orders must still be accepted below via geocoding), just checked first since it's free and
  // indexed. Takes the first match rather than requiring exactly one distinct row — the raw source
  // data records the same real city under several different casings (verified: "Los Angeles" also
  // appears as "los angeles", "LOS ANGELES", "Los angeles"), which a case-insensitive `distinct`
  // can't collapse since DISTINCT operates on the literal stored value, not the folded one. Any one
  // of those rows names the same real place, so ambiguity isn't a concern at this tier — that's
  // only a real risk at the geocoding tier below, where two DIFFERENT real places can share a name.
  const historyMatch = await prisma.orderHistory.findFirst({
    where: { city: { equals: trimmed, mode: "insensitive" } },
    select: { city: true, countryName: true },
  });
  if (historyMatch) {
    return {
      verified: true,
      city: historyMatch.city,
      country: historyMatch.countryName || null,
      source: "order_history",
      needsClarification: false,
      candidates: [],
    };
  }

  // Real geocoding — accepts a real city even with zero historical orders (Phase 8's explicit
  // requirement: "Do not reject a real city only because it is absent from order history").
  const { results } = await geocodePlace(trimmed);
  if (!results.length) {
    return { verified: false, city: null, country: null, source: null, needsClarification: false, candidates: [] };
  }

  // Multiple genuinely different real places share this name (e.g. "Paris" — France vs Texas) —
  // ask rather than silently picking one. Candidates with identical name+country are deduped.
  const distinctCandidates = [...new Map(results.map((r) => [`${r.name}|${r.country}`, r])).values()];
  if (distinctCandidates.length > 1) {
    return {
      verified: false,
      city: null,
      country: null,
      source: null,
      needsClarification: true,
      candidates: distinctCandidates.slice(0, 5).map((r) => ({ city: r.name, country: r.country || "" })),
    };
  }

  const match = distinctCandidates[0];
  return {
    verified: true,
    city: match.name,
    country: match.country || null,
    source: "geocoding",
    needsClarification: false,
    candidates: [],
  };
}

/**
 * @param {string} verifiedCityName - a city already confirmed via verifyCity (never raw customer text).
 * @returns {Promise<{ tempF: number, weatherCode: number, relativeHumidityPercent: number|null } | null>}
 */
export async function fetchCurrentWeather(verifiedCityName) {
  const { results } = await geocodePlace(verifiedCityName);
  const place = results[0];
  if (!place) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code,relative_humidity_2m&temperature_unit=fahrenheit`,
      { signal: controller.signal },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const current = data.current;
    if (!current) return null;
    return {
      tempF: Math.round(current.temperature_2m),
      weatherCode: current.weather_code,
      relativeHumidityPercent: typeof current.relative_humidity_2m === "number" ? Math.round(current.relative_humidity_2m) : null,
    };
  } catch (err) {
    console.error("Failed to fetch live weather:", err.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
