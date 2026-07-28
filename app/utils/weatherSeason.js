// Deterministic weather/season helpers — pure functions, no DB/network access, so both the tool
// layer (which does the real geocoding/forecast fetch) and tests can reason about them the same
// way. This is the fix for the "I've saved that it's summer" bug: the calendar season computed
// here is NEVER written into CustomerProfileState — it exists only as a display-time fallback
// suggestion, so it can never silently overwrite a season the customer actually stated.

// Northern-hemisphere mapping, matching the US-heavy source data (Michigan, Florida, Puerto Rico,
// etc.) — used only as a last-resort suggestion when the customer hasn't stated a season at all,
// never persisted to CustomerProfileState.season.
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

// Seasons paired with the weather words that would genuinely conflict with them — e.g. a "hot" or
// "sunny" reading alongside a stated Winter is worth surfacing; "cool"/"chilly"/"rainy" alongside
// Winter is not a conflict at all. Deliberately conservative (only the clearest mismatches) so this
// doesn't nag the customer over borderline/mild days.
const SEASON_CONFLICT_WORDS = {
  Winter: new Set(["hot", "sunny"]),
  Summer: new Set(["chilly", "cool"]),
  Spring: new Set(["hot"]),
  Fall: new Set(["hot"]),
};

/**
 * @param {string|null} statedSeason - the customer's stated/saved season, or null.
 * @param {string[]} weatherWords - from describeWeatherSimple().words.
 * @returns {boolean}
 */
export function hasSeasonWeatherConflict(statedSeason, weatherWords) {
  if (!statedSeason || !Array.isArray(weatherWords)) return false;
  const conflictWords = SEASON_CONFLICT_WORDS[statedSeason];
  if (!conflictWords) return false;
  return weatherWords.some((w) => conflictWords.has(w));
}
