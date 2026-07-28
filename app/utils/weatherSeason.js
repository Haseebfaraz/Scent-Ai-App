// Deterministic weather/season helpers — pure functions, no DB/network access, so both the tool
// layer (which does the real geocoding/forecast fetch) and tests can reason about them the same
// way. This is the fix for the "I've saved that it's summer" bug: the calendar season computed
// here is NEVER written into CustomerProfileState — it exists only as an ephemeral fallback (a
// ranking/query hint, or ice-breaker small talk), so it can never silently overwrite anything the
// customer actually stated.

// Northern-hemisphere mapping, matching the US-heavy source data (Michigan, Florida, Puerto Rico,
// etc.) — used only as a last-resort suggestion when there's no real weather reading yet, never
// persisted to CustomerProfileState.
const SEASON_BY_MONTH = ["Winter", "Winter", "Spring", "Spring", "Spring", "Summer", "Summer", "Summer", "Fall", "Fall", "Fall", "Winter"];

// A handful of countries where the calendar season runs opposite the northern-hemisphere default
// — deliberately a short, explicit, human-reviewed list (not a full country database) rather than
// a heuristic that could silently mis-flip a country nobody checked.
const SOUTHERN_HEMISPHERE_COUNTRIES = new Set([
  "australia", "new zealand", "argentina", "chile", "south africa", "brazil",
  "uruguay", "paraguay", "bolivia", "peru", "zimbabwe", "namibia", "botswana",
  "fiji", "madagascar",
]);

export function getCalendarSeason(countryName) {
  const monthIndex = new Date().getMonth();
  const northernSeason = SEASON_BY_MONTH[monthIndex];
  if (countryName && SOUTHERN_HEMISPHERE_COUNTRIES.has(countryName.trim().toLowerCase())) {
    const FLIP = { Winter: "Summer", Summer: "Winter", Spring: "Fall", Fall: "Spring" };
    return FLIP[northernSeason];
  }
  return northernSeason;
}

// WMO weather-code -> plain description, per Open-Meteo's documented code table (the only codes
// its forecast endpoint ever returns).
export const WMO_WEATHER_DESCRIPTIONS = {
  0: "clear sky", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "foggy", 48: "foggy with rime",
  51: "light drizzle", 53: "drizzle", 55: "dense drizzle",
  56: "light freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  66: "light freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light rain showers", 81: "rain showers", 82: "violent rain showers",
  85: "light snow showers", 86: "snow showers",
  95: "a thunderstorm", 96: "a thunderstorm with light hail", 99: "a thunderstorm with heavy hail",
};

// Maps a WMO code to one word from the customer-facing vocabulary the spec requires (Sunny,
// Cloudy, Rainy, Humid, Hot, Cool, Windy, Dry, Mild, Chilly) — condition words only; temperature
// words are added separately by describeWeatherSimple so "hot"/"cool"/"mild"/"chilly" reflect the
// real reading, not the WMO code.
const CONDITION_WORD_BY_CODE = {
  0: "sunny", 1: "sunny", 2: "cloudy", 3: "cloudy",
  45: "cloudy", 48: "cloudy",
  51: "rainy", 53: "rainy", 55: "rainy", 56: "rainy", 57: "rainy",
  61: "rainy", 63: "rainy", 65: "rainy", 66: "rainy", 67: "rainy",
  71: "rainy", 73: "rainy", 75: "rainy", 77: "rainy",
  80: "rainy", 81: "rainy", 82: "rainy",
  85: "rainy", 86: "rainy",
  95: "windy", 96: "windy", 99: "windy",
};

function temperatureWord(tempF) {
  if (tempF >= 85) return "hot";
  if (tempF <= 40) return "chilly";
  if (tempF <= 60) return "cool";
  return "mild";
}

/**
 * @param {number} tempF
 * @param {number} weatherCode - WMO code from Open-Meteo's `current.weather_code`.
 * @returns {{ words: string[], summary: string }} e.g. { words: ["hot","sunny"], summary: "hot and sunny" }
 */
export function describeWeatherSimple(tempF, weatherCode) {
  const conditionWord = CONDITION_WORD_BY_CODE[weatherCode] || "mild";
  const tempWord = temperatureWord(tempF);
  const words = [...new Set([tempWord, conditionWord])];
  return { words, summary: words.join(" and ") };
}

// Fix (season/weather v2) — a single deterministic climate-direction enum, derived automatically
// the moment a city is verified (never asked about, never left to the model). Priority: real rain
// beats a humidity reading, which beats a plain temperature band — a rainy 75°F day reads to a
// customer as "rainy" first, not "warm."
const RAIN_CODES = new Set(Object.entries(CONDITION_WORD_BY_CODE).filter(([, w]) => w === "rainy").map(([c]) => Number(c)));
const HUMID_MIN_TEMP_F = 65;
const HUMID_MIN_PERCENT = 60;

/**
 * @param {number} tempF
 * @param {number} weatherCode
 * @param {number|null} [relativeHumidityPercent]
 * @returns {"hot"|"warm"|"mild"|"cool"|"cold"|"humid"|"rainy"}
 */
export function deriveWeatherDirection(tempF, weatherCode, relativeHumidityPercent = null) {
  if (RAIN_CODES.has(weatherCode)) return "rainy";
  if (relativeHumidityPercent != null && relativeHumidityPercent >= HUMID_MIN_PERCENT && tempF >= HUMID_MIN_TEMP_F) return "humid";
  if (tempF >= 85) return "hot";
  if (tempF >= 70) return "warm";
  if (tempF >= 55) return "mild";
  if (tempF >= 40) return "cool";
  return "cold";
}

// Ephemeral mapping used ONLY to pick which real historical `season` bucket to query for
// evidence/ranking purposes (app/services/orderHistoryAnalysis.server.js) — never shown to the
// customer, never persisted as "the season." A documented, deliberately coarse judgment call:
// hot/warm/humid conditions read as Summer-like buying patterns, cold/cool as Winter-like; a
// genuinely ambiguous reading (mild, rainy, or no reading yet) defers to the calendar fallback.
export function weatherDirectionToQuerySeason(weatherDirection, calendarFallback) {
  if (weatherDirection === "hot" || weatherDirection === "warm" || weatherDirection === "humid") return "Summer";
  if (weatherDirection === "cold" || weatherDirection === "cool") return "Winter";
  return calendarFallback;
}

// A customer-requested season STYLE (e.g. "I want something wintery") genuinely conflicting with
// today's real weather direction — e.g. requesting "Winter" on a hot/warm/humid day is worth a
// single brief check-in; requesting "Winter" on a cool/cold/rainy day is not a conflict at all.
// Deliberately conservative so this never nags over a borderline/mild day.
const SEASON_STYLE_CONFLICT_DIRECTIONS = {
  Winter: new Set(["hot", "warm", "humid"]),
  Summer: new Set(["cold", "cool"]),
  Spring: new Set(["hot"]),
  Fall: new Set(["hot"]),
};

/**
 * @param {string|null} requestedSeasonStyle - the customer's explicitly requested style, or null.
 * @param {string|null} weatherDirection - from deriveWeatherDirection, or null if not fetched yet.
 * @returns {boolean}
 */
export function hasSeasonWeatherConflict(requestedSeasonStyle, weatherDirection) {
  if (!requestedSeasonStyle || !weatherDirection) return false;
  const conflictDirections = SEASON_STYLE_CONFLICT_DIRECTIONS[requestedSeasonStyle];
  if (!conflictDirections) return false;
  return conflictDirections.has(weatherDirection);
}
