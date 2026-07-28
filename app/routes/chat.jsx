import crypto from "crypto";
import { unauthenticated } from "../shopify.server";
import prisma, { createOrUpdateConversation, saveMessage, getConversationHistory } from "../db.server";
import Fuse from "fuse.js";
import { normalizeRegionText, normalizeProductName, SEASON_ALIASES } from "../utils/fragranceNormalization";
import { FRAGRANCE_AGENT_TOOLS, executeFragranceTool } from "../tools/fragranceAgentTools.server";
import { getCustomerProfile, getMissingRequiredFields } from "../services/customerProfile.server";
import { getRecommendation, markRecommendationShopifyProduct } from "../services/recommendationConfirmation.server";

// ============================================================
// REGION-BASED NOTE POPULARITY (from real order history, city -> state -> country fallback)
// ============================================================

// normalizeRegionText now lives in app/utils/fragranceNormalization.js (imported above) so
// ingestion scripts and the new recommendation services match location text identically to this
// file — moved, not duplicated.

// Distinct city/state/country names are cached after the first lookup — the underlying data
// doesn't change at runtime, and re-scanning ~937k rows for every message would be wasteful.
// Keyed by normalized text for matching, valued by the real casing stored in the DB — SQLite
// comparisons are case-sensitive by default (no "insensitive" query mode like Postgres has), so
// we look up the correctly-cased value here rather than trying to query case-insensitively later.
let cachedRegionMaps = null;
async function getRegionMaps() {
  if (cachedRegionMaps) return cachedRegionMaps;
  cachedRegionMaps = { city: new Map(), stateName: new Map(), countryName: new Map() };
  try {
    for (const field of ["city", "stateName", "countryName"]) {
      const rows = await prisma.orderHistory.findMany({
        distinct: [field],
        select: { [field]: true },
        where: { [field]: { not: null } }
      });
      for (const row of rows) {
        if (row[field]) cachedRegionMaps[field].set(normalizeRegionText(row[field]), row[field]);
      }
    }
  } catch (err) {
    console.error("Failed to load region lists:", err.message);
  }
  return cachedRegionMaps;
}

// Scans the customer's own messages for a known city, state, OR country name (whichever is
// most specific) — checking 1-4 word windows so multi-word names like "New York" or "United
// Arab Emirates" are caught. Not full NLP, just a lookup against real region names that exist
// in the order history data. A customer naming their country directly (e.g. "Spain") is just as
// valid a signal as naming a city — city is only preferred when both happen to be mentioned.
function extractRegionFromHistory(history, regionMaps) {
  const levels = [
    { field: "city", map: regionMaps.city },
    { field: "stateName", map: regionMaps.stateName },
    { field: "countryName", map: regionMaps.countryName }
  ];
  for (const msg of history) {
    if (msg.role !== "user" || typeof msg.content !== "string") continue;
    const words = normalizeRegionText(msg.content).split(" ").filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      for (let len = 4; len >= 1; len--) {
        const candidate = words.slice(i, i + len).join(" ");
        for (const { field, map } of levels) {
          if (map.has(candidate)) return { field, value: map.get(candidate) };
        }
      }
    }
  }
  return null;
}

// Catches a customer naming a city AND a country that don't actually belong together per the real
// order-history region data (e.g. "Paris" as their city but "USA" as their country) — scans for
// BOTH independently (not just the single highest-priority match extractRegionFromHistory
// returns), then checks the city's real country against what they said. A soft signal for the
// prompt to politely double-check, never a hard block — a legitimate city (Paris, Texas exists)
// or a customer just being imprecise shouldn't be treated as an error.
async function findCityCountryContradiction(history, regionMaps) {
  let mentionedCity = null;
  let mentionedCountry = null;
  for (const msg of history) {
    if (msg.role !== "user" || typeof msg.content !== "string") continue;
    const words = normalizeRegionText(msg.content).split(" ").filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      for (let len = 4; len >= 1; len--) {
        const candidate = words.slice(i, i + len).join(" ");
        if (!mentionedCity && regionMaps.city.has(candidate)) mentionedCity = regionMaps.city.get(candidate);
        if (!mentionedCountry && regionMaps.countryName.has(candidate)) mentionedCountry = regionMaps.countryName.get(candidate);
      }
    }
  }
  if (!mentionedCity || !mentionedCountry) return null;
  try {
    const cityMatch = await prisma.orderHistory.findFirst({
      where: { city: mentionedCity },
      select: { countryName: true }
    });
    if (cityMatch?.countryName && cityMatch.countryName !== mentionedCountry) {
      return { city: mentionedCity, statedCountry: mentionedCountry, actualCountry: cityMatch.countryName };
    }
  } catch (err) {
    console.error("Failed to check city/country contradiction:", err.message);
  }
  return null;
}

// Used by the deterministic city-enforcement intercept in callAI — once we've asked this once, we
// don't force it again even if the customer's answer still doesn't resolve to a real city in our
// data. Our city list is only whatever distinct cities happen to appear in order_history, not an
// exhaustive world database, so a customer's real city genuinely might not be recognized — asking
// exactly once is a hard guarantee without risking an unsatisfiable, endless loop for them.
const CITY_QUESTION_PATTERN = /which (specific )?city|what city/i;
function wasCityAsked(history) {
  return history.some(msg =>
    msg.role === "assistant" && typeof msg.content === "string" && CITY_QUESTION_PATTERN.test(msg.content)
  );
}

function tallyNotes(orders, limit) {
  const tally = {};
  for (const order of orders) {
    const notes = order.notes.split(",").map(n => n.trim()).filter(Boolean);
    for (const note of notes) {
      tally[note] = (tally[note] || 0) + 1;
    }
  }
  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

function tallyClassifications(orders, limit) {
  const tally = {};
  for (const order of orders) {
    const c = (order.classification || "").trim();
    if (!c) continue;
    tally[c] = (tally[c] || 0) + 1;
  }
  return Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

// Northern-hemisphere mapping, matching the US-heavy source data (Michigan, Florida, Puerto Rico,
// etc. in the sample) and the existing weather small talk, which already assumes this convention.
const SEASON_BY_MONTH = ["Winter", "Winter", "Spring", "Spring", "Spring", "Summer", "Summer", "Summer", "Fall", "Fall", "Fall", "Winter"];
function getCurrentSeason() {
  return SEASON_BY_MONTH[new Date().getMonth()];
}

// WMO weather-code -> plain description, per Open-Meteo's documented code table (the only codes
// its forecast endpoint ever returns).
const WMO_WEATHER_DESCRIPTIONS = {
  0: "clear sky", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "foggy", 48: "foggy with rime",
  51: "light drizzle", 53: "drizzle", 55: "dense drizzle",
  56: "light freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  66: "light freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light rain showers", 81: "rain showers", 82: "violent rain showers",
  85: "light snow showers", 86: "snow showers",
  95: "a thunderstorm", 96: "a thunderstorm with light hail", 99: "a thunderstorm with heavy hail"
};

// Real current conditions for wherever the customer says they live — Open-Meteo needs no API key:
// geocode the place name to coordinates, then pull the current forecast. Cached briefly per place
// since weather doesn't meaningfully change turn-to-turn within one conversation. Now that a real
// city is strictly enforced (see the callAI gate), this should resolve reliably far more often
// than it did the first time this was tried, when the location could still be country-level only.
const WEATHER_CACHE = new Map(); // normalized place -> { data, fetchedAt }
const WEATHER_CACHE_TTL_MS = 30 * 60 * 1000;
async function getLiveWeather(placeName) {
  if (!placeName) return null;
  const cacheKey = placeName.toLowerCase().trim();
  const cached = WEATHER_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < WEATHER_CACHE_TTL_MS) return cached.data;

  try {
    const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(placeName)}`);
    if (!geoRes.ok) return null;
    const geoData = await geoRes.json();
    const place = geoData.results?.[0];
    if (!place) return null;

    const forecastRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code&temperature_unit=fahrenheit`);
    if (!forecastRes.ok) return null;
    const forecastData = await forecastRes.json();
    const current = forecastData.current;
    if (!current) return null;

    const result = {
      tempF: Math.round(current.temperature_2m),
      description: WMO_WEATHER_DESCRIPTIONS[current.weather_code] || "typical weather"
    };
    WEATHER_CACHE.set(cacheKey, { data: result, fetchedAt: Date.now() });
    return result;
  } catch (err) {
    console.error("Failed to fetch live weather:", err.message);
    return null;
  }
}

// SEASON_ALIASES now lives in app/utils/fragranceNormalization.js (imported above) so the
// recommendation engine services query season the same way this file does — moved, not duplicated.

// Cascades from whichever level was actually matched down to broader ones (city -> its state ->
// its country, or state -> its country, or country alone) if the more specific sample is too
// small to be meaningful — matches how real fragrance popularity actually varies by region. Tries
// region+CURRENT SEASON first at every level (avoids e.g. recommending heavy oud in summer just
// because it's popular in that region year-round), falling back to region alone if the
// season-narrowed sample is too thin to be meaningful. Returns classification (style) popularity
// alongside notes — both already sit in the DB but were previously unused.
const MIN_SAMPLE_SIZE = 20;
// Three-tier fallback: (1) region + current season, cascading city -> state -> country as each
// level is tried, (2) region alone (any season) at the same cascade, (3) a genuinely global,
// location-free tally (season-first, then unrestricted) when there's no region at all yet or the
// real regional sample is too thin to mean anything. Tier 3 is real data, not a guess — it answers
// "what's popular overall" instead of leaving the customer with zero data-backed signal just
// because their specific city/state/country combination doesn't have enough orders on its own.
// Callers can tell tier 3 happened via `isGlobalFallback` and should phrase it as "customers
// overall" rather than implying it's specific to their region.
// When a vibe is given, fuzzy-ranks a region+season-matched batch by relevance to it BEFORE
// tallying notes — otherwise a broadly-popular-but-irrelevant regional note (e.g. a heavy amber
// base that's popular locally but has nothing to do with a customer asking for "fruity") can drown
// out the one signal that actually matters: what they just told you they want. Falls back to the
// full unfiltered batch if fuzzy-matching the vibe against real order rows turns up too little to
// tally meaningfully — a thin/no match here shouldn't leave the customer with zero regional signal.
// A narrowed subset of an already-region-validated batch doesn't need to clear the same bar as
// the regional batch itself (MIN_SAMPLE_SIZE=20 exists to validate a whole city/state/country
// slice, not a further vibe-relevant refinement of one) — verified directly against real data
// that requiring 20 caused this to silently no-op on a 51-row Karachi sample (only 19 rows
// matched "fruity"), even though those 19 rows contained real, meaningfully different signal
// (Apple, Grapefruit, Pineapple, Blackcurrant) that the unfiltered 51-row tally buried entirely.
const MIN_VIBE_MATCH_SIZE = 5;
function narrowOrdersByVibe(orders, vibe) {
  if (!vibe) return orders;
  const fuse = new Fuse(orders, { keys: ["notes", "classification"], threshold: 0.4, ignoreLocation: true });
  const matched = fuse.search(vibe).map(r => r.item);
  return matched.length >= MIN_VIBE_MATCH_SIZE ? matched : orders;
}

async function getPopularNotesForRegion(region, limit = 8, seasonOverride = null, vibe = null) {
  const seasonValues = SEASON_ALIASES[seasonOverride] || SEASON_ALIASES[getCurrentSeason()];

  try {
    if (region) {
      const { field, value } = region;
      let attempts;
      if (field === "city") {
        const cityMatch = await prisma.orderHistory.findFirst({
          where: { city: value },
          select: { stateName: true, countryName: true }
        });
        attempts = [
          { city: value },
          cityMatch?.stateName && { stateName: cityMatch.stateName },
          cityMatch?.countryName && { countryName: cityMatch.countryName }
        ];
      } else if (field === "stateName") {
        const stateMatch = await prisma.orderHistory.findFirst({
          where: { stateName: value },
          select: { countryName: true }
        });
        attempts = [
          { stateName: value },
          stateMatch?.countryName && { countryName: stateMatch.countryName }
        ];
      } else {
        attempts = [{ countryName: value }];
      }
      attempts = attempts.filter(Boolean);

      for (const where of attempts) {
        const seasonalOrders = await prisma.orderHistory.findMany({
          where: { ...where, season: { in: seasonValues } },
          select: { notes: true, classification: true },
          take: 3000 // cap the scan for performance on a ~937k row table
        });
        if (seasonalOrders.length >= MIN_SAMPLE_SIZE) {
          const relevant = narrowOrdersByVibe(seasonalOrders, vibe);
          return { notes: tallyNotes(relevant, limit), classifications: tallyClassifications(relevant, 3), isGlobalFallback: false };
        }
      }
      for (const where of attempts) {
        const orders = await prisma.orderHistory.findMany({
          where,
          select: { notes: true, classification: true },
          take: 3000
        });
        if (orders.length >= MIN_SAMPLE_SIZE) {
          const relevant = narrowOrdersByVibe(orders, vibe);
          return { notes: tallyNotes(relevant, limit), classifications: tallyClassifications(relevant, 3), isGlobalFallback: false };
        }
      }
    }

    // Tier 3 — no region yet, or the regional sample never cleared the bar. Season-only first,
    // then fully unrestricted, both still real aggregate order-history data.
    const seasonalGlobal = await prisma.orderHistory.findMany({
      where: { season: { in: seasonValues } },
      select: { notes: true, classification: true },
      take: 3000
    });
    if (seasonalGlobal.length >= MIN_SAMPLE_SIZE) {
      const relevant = narrowOrdersByVibe(seasonalGlobal, vibe);
      return { notes: tallyNotes(relevant, limit), classifications: tallyClassifications(relevant, 3), isGlobalFallback: true };
    }
    const global = await prisma.orderHistory.findMany({
      select: { notes: true, classification: true },
      take: 3000
    });
    if (global.length >= MIN_SAMPLE_SIZE) {
      const relevant = narrowOrdersByVibe(global, vibe);
      return { notes: tallyNotes(relevant, limit), classifications: tallyClassifications(relevant, 3), isGlobalFallback: true };
    }
  } catch (err) {
    console.error("Failed to look up regional notes:", err.message);
  }
  return { notes: [], classifications: [], isGlobalFallback: false };
}

// ============================================================
// 2. CONVERSATION MEMORY
// ============================================================
const CONVERSATIONS = new Map();

// CONVERSATIONS is wiped on every server restart (routine on Render's free tier — cold starts,
// redeploys) even though every message is also durably saved to Postgres via saveMessage(). When
// a returning customer's id isn't in memory, this rehydrates from the DB instead of silently
// starting a blank conversation — otherwise the customer would see their old messages returned by
// the history endpoint while the AI itself had no memory of any of it (a real correctness bug,
// not just a display one, since callAI builds on this same history).
async function getConversation(conversationId) {
  if (conversationId && CONVERSATIONS.has(conversationId)) {
    return { id: conversationId, history: CONVERSATIONS.get(conversationId) };
  }

  if (conversationId) {
    const dbMessages = await getConversationHistory(conversationId);
    if (dbMessages.length > 0) {
      const history = dbMessages.map(m => ({ role: m.role, content: m.content }));
      CONVERSATIONS.set(conversationId, history);
      return { id: conversationId, history };
    }
  }

  const id = crypto.randomUUID();
  CONVERSATIONS.set(id, []);
  return { id, history: CONVERSATIONS.get(id) };
}

// ============================================================
// 3. SYSTEM PROMPT
// ============================================================
// The step-by-step scripted flow and its validation gate chain (name/location/email checks,
// draft-pitch checks, position-distribution checks, etc.) were deliberately discarded here to make
// room for a new conversation design — see the "Backup checkpoint before rewriting the chat flow
// from scratch" commit for the full previous version if anything needs to be recovered from it.
async function buildSystemPrompt(history, conversationId, knownCustomerEmail, knownCustomerName) {
  const regionMaps = await getRegionMaps();
  const regionCandidate = extractRegionFromHistory(history, regionMaps);
  const { notes: regionalNotes, classifications: regionalClassifications, isGlobalFallback } = await getPopularNotesForRegion(regionCandidate);
  const currentSeason = getCurrentSeason();
  const classificationClause = regionalClassifications.length > 0
    ? `, often leaning toward ${regionalClassifications.join(" or ")}-style fragrances`
    : "";
  // isGlobalFallback means there wasn't enough real data for their specific city/state/country —
  // this is still real order-history data, just not specific to their region, so the phrasing must
  // say "overall" rather than falsely implying it's local to them.
  const regionalNotesLine = regionalNotes.length > 0
    ? isGlobalFallback
      ? `\nReal customers overall (not specific to their exact region — there wasn't enough regional data yet) have shown a taste for these notes during ${currentSeason}: ${regionalNotes.join(", ")}${classificationClause}. Weave this in naturally during Turn 3 — phrase it as a general trend ("a lot of people tend to go for...") never as something specific to their city, since it isn't.\n`
      : `\nReal past customers from this same region during ${currentSeason} have shown a taste for these notes: ${regionalNotes.join(", ")}${classificationClause}. Weave this in naturally during Turn 3, as validating color commentary while they're describing their lifestyle or taste — the way a real perfumer would affirm a choice by mentioning it's popular locally ("that tracks — a lot of people around here lean that way this time of year"). Don't just leave this sitting unused; find a natural moment for it before you get to Phase 4's recommendation.\n`
    : "";
  // Chat is now strictly gated behind Shopify account login (see chat-interface.liquid's
  // {% if customer %}), so knownCustomerEmail is expected on every real request. knownCustomerName
  // is genuinely null fairly often though — accounts created via New Customer Accounts' email+OTP
  // sign-in have no name field at all — so step 1 below branches on whether it's known instead of
  // assuming it always is.
  const displayName = knownCustomerName || null;

  const cityCountryContradiction = await findCityCountryContradiction(history, regionMaps);
  const contradictionLine = cityCountryContradiction
    ? `\nHeads up: they mentioned "${cityCountryContradiction.city}" as their city and "${cityCountryContradiction.statedCountry}" as their country, but real regional data has that city in ${cityCountryContradiction.actualCountry} instead. Politely double-check which is right, without sounding accusatory — e.g. "just to make sure I've got it right, is that the ${cityCountryContradiction.city} in ${cityCountryContradiction.actualCountry}?" People do live in similarly-named cities in different countries, so this might be completely correct — just confirm rather than assuming they made a mistake.\n`
    : "";

  // Real current conditions for their actual city — only attempted once we have a real city
  // (not just a country/state), since that's what the strict city gate in callAI now guarantees
  // and what geocoding actually needs to resolve reliably.
  const liveWeather = regionCandidate?.field === "city" ? await getLiveWeather(regionCandidate.value) : null;
  const liveWeatherLine = liveWeather
    ? `\nReal current weather where they live: ${liveWeather.tempF}°F, ${liveWeather.description}. Use this to inform your weather comment, but TRANSLATE it into casual, descriptive language a high-end perfumer would actually say — NEVER state the raw degrees or repeat the technical phrase verbatim. E.g. ${liveWeather.tempF}°F and "${liveWeather.description}" becomes something like "${liveWeather.tempF >= 80 ? "It sounds like a proper warm one over there!" : liveWeather.tempF <= 45 ? "Sounds like a real crisp chill in the air over there!" : "It sounds like a pleasantly mild day over there!"}" — never the number, never the exact phrase, just the feeling of it. Still never invent or guess a DIFFERENT condition than what's given here — only change how it's phrased, not what it says.\n`
    : "";

  // The backend, not the model's own memory, tracks which structured profile fields are already
  // saved — Phase 13's fix for the old design depending on the model remembering "which turn it's
  // on." Injected here as a plain fact so the model never has to guess or re-derive it.
  const profile = await getCustomerProfile(conversationId);
  const missingFields = getMissingRequiredFields(profile);
  const profileStatusLine = `\nProfile fields already saved (from save_customer_profile_field — do not ask again for these): ${JSON.stringify(profile)}\nStill missing before analysis can run: ${missingFields.length ? missingFields.join(", ") : "nothing — ready to analyze."}\n`;

  return `You are Dua Scent Agent, a high-end, empathetic, and knowledgeable fragrance expert — the voice of a real, experienced perfumer with the warmth and conversational flair of a passionate expert at a high-end counter — observant, a little playful, genuinely curious about each customer. You help customers discover which real DUA fragrances suit them, and — when a genuinely new combination of real DUA products would suit them even better — recommend that too, always backed by real historical order data and real product notes, never invented. (That "counter" description is about your tone and expertise only — you are having a text conversation, not standing anywhere physical, so never actually tell the customer you're located somewhere or that they've walked into a shop.)
The current season is ${currentSeason}.
${regionalNotesLine}${contradictionLine}${liveWeatherLine}${profileStatusLine}

You are a real person having a real conversation, not a form, questionnaire, or automated script — never sound like one. The flow below is a persona guideline describing the general arc of what you need to learn and roughly when, as a guide for judgment, NOT a rigid state machine or a fixed sequence of exact lines to recite. Read what the customer actually wrote — including typos, slang, abbreviations, casual banter, and short or offhand replies (e.g. "idk", "lol yeah", "kinda busy tbh") — and respond to the real meaning and tone of it, the way a sharp, attentive human would, instead of getting stuck, asking them to rephrase, or defaulting to a generic clarifying line. If their reply also asks something of you, teases you, or makes small talk, always answer that like a warm human first — briefly and in character — before continuing on with whatever comes next; never ignore something directed at you just because it doesn't fit the expected shape of the step you're on. Answering something directed at you (a reciprocal question, banter, a reaction) and then continuing into the SAME next beat can live together in one warm, natural message (e.g. answering "and you?" and then introducing yourself and asking their name, all in one message) — that's blending small talk into onboarding, not skipping a step. This is different from bundling two genuinely separate pieces of information you still need (like name and city, or city and email) into one message — those still each get their own message and their own wait, exactly as laid out below, since collapsing those specifically is what has made this feel like a rigid form in the past.

How the conversation actually flows (a guideline for the general arc and judgment calls, not a strict script — read the room and adapt; the numbered steps below are what to accomplish and roughly in what order, not exact lines to recite verbatim):

CRITICAL: this customer is already signed in to their Shopify account, so their email is already on file — Do NOT ask for their email, ever, under any circumstance.

${displayName ? `Their name is already known too: ${displayName}. Do NOT ask for their name.` : `Their account has no name on file (this happens — some sign-in methods only collect an email, never a name). Since you genuinely don't know it, your very first message is a warm greeting that asks for their name AS ITS OWN QUESTION — e.g. "Hey there! Hope you're having a good day. What should I call you?" NEVER invent or guess a name from their email address or anything else — a guessed name (e.g. turning an email like "haseebfaraz2000@..." into "Haseebfaraz2000") reads worse than just asking. Wait for their real reply. Read it for what it actually is — if it doesn't look like a real name, gently clarify instead of guessing.`}

Do NOT describe yourself as physically located anywhere (no "stepping into the shop/studio," no venue framing at all). Wait for their reply before moving on.

STRICT ONE-QUESTION-PER-TURN RULE for everything below: every message you send contains exactly ONE question (or, where noted, a brief acknowledgment plus exactly one question) — never two questions stacked in the same message, no matter how related they feel to you. That's the #1 way this has read like a form instead of a conversation in the past.

TURN 1 — Greeting, day only. CRITICAL: do NOT mention fragrance, vibe, notes, perfume, or city anywhere in this turn — that all comes later, never here. ${displayName ? `Your very first message greets ${displayName} by name warmly and asks ONLY how their day is going or how they're doing — e.g. "Nice to meet you, ${displayName}! How's your day going so far?"` : `Once you have their real name, greet them warmly and ask ONLY how their day is going or how they're doing — e.g. "Nice to meet you, {name}! How's your day going so far?"`} This is the ONE question in this message — nothing else. Wait for their reply.

TURN 2 — Casual lifestyle chat, STILL no fragrance talk. Once they've replied to the day/feelings question, briefly acknowledge what they actually said (e.g. "Glad to hear that!", "Hope it gets better from here!" — vary this and react to their real answer, not a generic reflex), THEN in that SAME message ask ONE open question about their day or routine in plain human terms — e.g. "So what's on your schedule today?" or "What's a typical day look like for you?" NOT about scent, vibe, or preferences — this is still just two friends catching up. If they mention a concrete activity (e.g. "going to the gym," "big meeting today," "just relaxing at home"), that's exactly the material Turn 3 needs — don't rush past it. This acknowledgment-plus-one-question is the only exception to strict one-thing-per-message — the acknowledgment isn't a second question, just a reaction. Wait for their reply.

TURN 3+ — Genuine follow-up, then a natural bridge into scent, then location. Keep this friendly and human, like catching up with a friend who happens to be a perfumer, not an intake form. Each message here still carries only ONE question (or, for the bridge below, a warm observation with no question at all, followed later by the city ask as its own separate message):
   a. React specifically to whatever activity or routine detail they just shared — actually talk about it like a friend would (e.g. if they said "going to the gym," ask how their workout routine's going, or react to it genuinely) — ask ONE real follow-up before moving on. If their first answer was already rich with detail, one follow-up is enough — but there must be at least one genuine back-and-forth about their actual life BEFORE scent ever comes up.
   b. CRITICAL — ABSOLUTELY NEVER ask a choice question that hands the customer options to pick between, in ANY form — not a category list, and not a binary either/or question. This means things like "do you prefer warm or fresh?", "cozy or lively?", "would you say clean & minimal or rich & woody?" are all banned outright, exactly as much as a longer multiple-choice list is. If you're ever about to phrase a question with "or" between two scent-style words, stop — that's the exact failure pattern to avoid. This applies to the bridge in (c) below too — it's phrased as an observation with example directions, never as a forced pick between two.
   c. Bridge into scent — as your own observation, not a question. Once you have a real, concrete activity/lifestyle/occasion detail from (a), connect it to a scent direction yourself, the way an attentive perfumer naturally would, e.g. "Since you're hitting the gym today, fresh, invigorating, or aquatic profiles usually keep the energy up without feeling heavy." Offer this as a genuine suggestion grounded in what they actually told you — never invent an activity they didn't mention. If they've already shared ANY real context by now — a clear occasion, mood, personal vibe, occupation, daily routine, or even just an evocative phrase like "special moments at home" (e.g. "I want to make this memorable for my wife at our wedding," "something confident for a big presentation," "just want to feel put-together for work," "I'm a developer, mostly working morning shifts," "just started a new job," "just want something nice for cozy nights in") — that IS enough to bridge from. Only fall back to directly asking an open, non-either/or vibe question (e.g. "What kind of vibe are you hoping to capture today?") if they've given you truly nothing to bridge from at all (e.g. just "nice," "good," "whatever," with zero real context). If they volunteer personal or family context while sharing any of this (e.g. "my grandfather always wore vetiver," "we always leaned toward subtle scents"), warmly acknowledge it in the moment and let any specific notes they mention inform the blend — but never ask about their background, age, gender, or ethnicity directly, and never treat any of that as a factor you're tracking or looking anything up by.
   d. Only once you've completed the lifestyle follow-up in (a) and the bridge (or fallback vibe question) in (c) — never earlier — naturally ask for their city, in its OWN message with no other question attached. STRICT RULE: never explain WHY you're asking — no mention of climate, weather, local taste, note projection, or any other technical reason. Just ask it casually as a genuine part of getting to know them, the way you'd ask a new friend where they're from — e.g. "By the way, what city are you based in?", "Where are you chatting from today?", or "By the way, which city are you in?" Not just "where are you based" (too vague, invites a country-only answer that's far less useful). A country or region alone isn't enough — if they answer with only a country or a vague region, warmly ask which city specifically. If their answer isn't a place at all (e.g. "gym," "work," "home," something off-topic), don't treat it as a city and don't just coldly re-ask — acknowledge what they actually said with warmth first (e.g. "Oh, getting a workout in? Nice!"), then gently steer back to asking specifically which city they're in — still just the one question. Wait for a real city answer before moving on. THEN, once you have their city, send a message that ONLY riffs on the weather for that location given above — a genuine comment, not a question about anything else. If a real current weather reading is given above, base your comment on THAT real condition, but translate it into warm, casual, descriptive language — NEVER state the exact degrees or repeat a technical phrase like "clear sky" verbatim; say something like "sounds like a pleasantly crisp day over there!" instead. Never guess or invent a DIFFERENT condition than what's given, just phrase it naturally. Only fall back to a general seasonal comment if no real reading was given at all. STOP there and wait for their reply to that specific comment before doing anything else. Every one of these is its own separate message, each waiting for a real reply before the next — never bundle two of them together; that reads as a form, not a conversation.

PHASE 4 — Save profile fields as you learn them, then analyze. Throughout Turns 1-3, the moment you learn a real piece of profile information, CALL save_customer_profile_field for it immediately — don't wait until the end, and don't just hold it in conversation memory:
   - City: as soon as they give a real city (Turn 3d).
   - Country: infer it from the city if you're genuinely confident (e.g. "Los Angeles" implies "United States"); ask directly only if truly ambiguous.
   - Season: default to the current real-world season given above and save it as soon as you know their country, UNLESS they explicitly state a different season where they live (seasons run opposite by hemisphere) — if they correct it, save their stated season instead.
   - likes / preferredStyle / occasion: as soon as their bridge (Turn 3c) or any later reply expresses a real style/mood/occasion direction (e.g. "fresh, invigorating" -> likes: ["Fresh"]; "for my wife's wedding" -> occasion: "wedding").
   - dislikes: as soon as they mention anything they want to avoid.
   Once Turn 3d is complete (you have their city, or they've dodged it after a genuine attempt) and you have at least one real like/preferredStyle signal, CALL get_customer_profile to confirm nothing required is still missing (the profile status above already tells you this — use get_customer_profile if you want to double check after saving new fields). Do NOT ask another follow-up question just to gather more once the required fields are met — take ownership and move to analysis.
   Once nothing required is missing: CALL analyze_customer_product_candidates (no arguments needed — it reads the saved profile) to deterministically score real DUA products using real order-history evidence. Never invent a product name or a score — only ever use what this tool returns. Then CALL generate_new_product_combinations to get genuinely NEW combination proposals (Hybrid = 2 real products, Tribrid = 3, Quadbrid = 4) — every proposal is already checked against the real existing-combination database and only returned if it's genuinely new. Never invent your own combination outside of what this tool returns.

Presenting results — for each of up to three combination proposals generate_new_product_combinations returns:
   - Give it your own fitting, creative name (the tool doesn't name it).
   - State the real product titles that make it up, plainly — real DUA product names ARE allowed to the customer now, this isn't the old note-container system.
   - Say whether it's a Hybrid, Tribrid, or Quadbrid, and its overall direction (mainDirection).
   - Name the key notes from each product (from its notes) and, briefly, why they work together (compatibilityReasons) and why it suits THIS customer (customerFitReasons) — grounded in the real reasons given, never invented ones.
   - Mention historical evidence in AGGREGATE, ANONYMOUS terms only, e.g. "similar customers in this region have shown real interest in this direction" — NEVER name or imply any specific other customer, never state an exact identity, only a count or general trend.
   - Give the recommendedRatio and label it clearly as an AI-analytical mixing suggestion, not an official house ratio.
   - State its confidence plainly, and mention any risks as a friendly, honest heads-up (e.g. "heads up, this leans quite strong for warm weather").
   - Always call it a "new proposed combination" — this tool never returns anything that already exists, so never claim otherwise.
   - NEVER mention or expose a recommendationId, database ID, handle, or any other internal/technical identifier — those are strictly internal.
   Close by inviting their reaction, e.g. "How do these sound? Want me to adjust any of them, or shall we create one?"

PHASE 5 — Refinement. If the customer reacts with something like "make it sweeter," "show me fresher combinations," "remove spicy notes," "give me only new combinations," "give me a Hybrid only," or just asks for another option, CALL refine_combination_recommendations with their feedback in their own words (verbatim or closely paraphrased) — never regenerate or adjust combinations yourself from memory. If they ask a specific question about one product's notes or where else it's used, CALL get_product_notes_and_combination_status, find_existing_combinations_for_product, or find_combinations_using_similar_notes rather than guessing or recalling from earlier in the conversation.

PHASE 6 — Confirmation and creation. Once the customer clearly picks ONE specific combination (by the name you gave it, or by clearly indicating which one, e.g. "let's do the second one," "yes, create that"), CALL confirm_product_combination with that exact recommendationId from your own tool results (never a reconstructed product list, and never a recommendationId you made up). If it succeeds, immediately CALL create_shopify_custom_combination_product with the same recommendationId, then tell the customer warmly that it's being created. If confirm_product_combination returns an error, explain the real problem to the customer plainly (e.g. ask for whatever's missing, or explain the combination is no longer available) — never pretend it succeeded, and never retry blindly without addressing the actual reason given.

Rules:
- Real DUA product names ARE allowed in your replies — say them plainly. Internal database IDs, recommendationIds, handles, and any other technical identifier must NEVER appear in a reply to the customer.
- NEVER reveal another customer's name, email, or any individually-identifiable detail. Historical evidence is always aggregate and anonymous (e.g. "several similar customers in this region" is fine; naming or implying a specific person never is).
- Gender is never a hard restriction on any recommendation. Race/ethnicity is never a factor in any recommendation, ever.
- Never invent a product, note, score, ratio, risk, or combination that a tool call didn't actually return.
- Keep replies warm and conversational — a real back-and-forth, not clinical, but don't ramble; let the customer drive the pace.
- Act like a real salesperson who talks to many different customers, each one differently — never fall back on the exact same fixed wording every conversation. Vary your phrasing, your examples, and your reactions based on what THIS specific customer actually said.
- Read each reply for what it actually says before responding to it. If someone's answer doesn't seem to match what you just asked, that means they answered something else or got confused — don't force it to fit. Gently clarify instead of guessing.`;
}

// ============================================================
// 4. TOOL DEFINITIONS — see app/tools/fragranceAgentTools.server.js for the 11 Phase 9 tools
// (FRAGRANCE_AGENT_TOOLS) and their Zod-validated dispatch (executeFragranceTool).
// ============================================================

// ============================================================
// 5. OPENAI API CALL (with tool-use resolution loop)
// ============================================================
// A dead network connection or an OpenAI outage that hangs instead of erroring would otherwise
// leave this fetch waiting forever with no timeout — the customer's chat bubble would just sit
// there indefinitely. The 30s AbortController bound below, plus wrapping the whole call in
// try/catch, means every failure mode (bad status, network error, timeout, malformed JSON) ends
// the same way: a clean `null` return, which callAI already turns into a warm, visible fallback
// message instead of an unhandled rejection.
const OPENAI_REQUEST_TIMEOUT_MS = 30000;
async function callOpenAIOnce(apiKey, messages, useTools) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.3,
        ...(useTools ? { tools: FRAGRANCE_AGENT_TOOLS } : {})
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("OpenAI API error:", response.status, errText);
      return null;
    }

    return await response.json();
  } catch (err) {
    console.error("OpenAI request failed:", err.name === "AbortError" ? "timed out after " + OPENAI_REQUEST_TIMEOUT_MS + "ms" : err.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Independent of whatever the model passes as customerEmail — scans the customer's own messages
// directly, so a real email the customer typed is never lost just because the model failed to
// carry it through into the tool call correctly.
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
function extractEmailFromHistory(history) {
  for (const msg of history) {
    if (msg.role === "user" && typeof msg.content === "string") {
      const match = msg.content.match(EMAIL_PATTERN);
      if (match) return match[0];
    }
  }
  return null;
}

// knownCustomerEmail/knownCustomerName come straight from the customer's real, logged-in Shopify
// account (the theme extension strictly gates chat behind {% if customer %} now — see
// chat-interface.liquid) — trusted as verified account data, not a self-reported or model guess.
async function callAI(history, conversationId, knownCustomerEmail, knownCustomerName) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { replyText: "Configuration error: missing API key.", readyForShopifyCreation: null, sseEvents: [] };
  }

  // Strict city enforcement — this has repeatedly failed to hold as just a soft prompt
  // instruction (e.g. a customer saying "United Kingdom" got accepted as sufficient location data
  // instead of prompting for a city). Deterministically forces the city question once a
  // country/state-only match is detected, guaranteeing it happens instead of hoping the model
  // remembers — but only ONCE (see wasCityAsked), since our city list is just whatever appears in
  // order_history, not an exhaustive database, and a real city that isn't recognized should never
  // trap the customer in an endless re-ask.
  const regionMapsForGate = await getRegionMaps();
  const regionCandidateForGate = extractRegionFromHistory(history, regionMapsForGate);
  if (regionCandidateForGate && regionCandidateForGate.field !== "city" && !wasCityAsked(history)) {
    const askText = `${regionCandidateForGate.value} — lovely! Which specific city are you in? That'll help me give you the best local recommendations.`;
    return {
      replyText: askText,
      readyForShopifyCreation: null,
      sseEvents: [],
      updatedMessages: [...history, { role: "assistant", content: askText }]
    };
  }

  let messages = [{ role: "system", content: await buildSystemPrompt(history, conversationId, knownCustomerEmail, knownCustomerName) }, ...history];
  let finalText = "";
  let readyForShopifyCreation = null;
  const sseEvents = [];
  const toolContext = {
    conversationId,
    customerName: knownCustomerName,
    customerEmail: knownCustomerEmail || extractEmailFromHistory(history),
  };

  // Up to 6 tool-resolution turns — a full profile -> analyze -> generate -> confirm -> create
  // chain can genuinely need more back-and-forth than the old 4-tool flow did.
  for (let turn = 0; turn < 6; turn++) {
    const data = await callOpenAIOnce(apiKey, messages, true);
    if (!data) {
      return { replyText: "Sorry, I'm having trouble reaching the fragrance engine right now.", readyForShopifyCreation: null, sseEvents };
    }

    const choice = data.choices[0];
    const message = choice.message;
    const toolCalls = message.tool_calls;

    if (choice.finish_reason === "tool_calls" && toolCalls && toolCalls.length > 0) {
      messages.push({ role: "assistant", content: message.content || null, tool_calls: toolCalls });

      for (const toolCall of toolCalls) {
        const result = await executeFragranceTool(toolCall.function.name, toolCall.function.arguments, toolContext);
        if (result.sseEvent) sseEvents.push(result.sseEvent);
        if (result.readyForShopifyCreation) readyForShopifyCreation = result.readyForShopifyCreation;

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result.modelContent
        });
      }
      continue;
    }

    finalText = message.content || "";

    // Deterministic safety net — real DUA product TITLES are allowed to the customer now, but
    // internal technical identifiers (Prisma's cuid-style IDs, e.g. recommendationId) never are.
    // Mirrors the old title-leak guard's role but for a narrower, still-real risk under the new
    // rules: a long lowercase alphanumeric token starting with "c" doesn't occur in ordinary
    // English, so this only ever fires on an actual leaked ID, not real prose.
    const leakedId = turn < 5 && /\bc[a-z0-9]{20,}\b/i.test(finalText);
    if (leakedId) {
      messages.push({ role: "assistant", content: finalText });
      messages.push({
        role: "system",
        content: `CRITICAL: your last reply contained what looks like an internal database identifier — customers must NEVER see this. Rewrite that reply now without any technical ID, using only the combination's name and real product titles instead.`
      });
      continue;
    }

    messages.push({ role: "assistant", content: finalText });
    break;
  }

  // Strip the system message before persisting (it's rebuilt fresh each call)
  const persistedMessages = messages.filter(m => m.role !== "system");

  return {
    replyText: finalText || "Let's get that crafted for you.",
    readyForShopifyCreation,
    sseEvents,
    updatedMessages: persistedMessages
  };
}

// ============================================================
// 6. DYNAMIC PRODUCT CREATION
// ============================================================
// Used only when a component product's real pricePer5ml is somehow missing from the catalog —
// shouldn't happen since every FragranceProduct row is populated, but keeps product creation from
// ever computing a $0 price.
const FALLBACK_PRICE_PER_5ML = 20;

// Real animated bottle renders hosted on the shop's own CDN — a different one for a 2-component
// blend vs. a 3+ component blend, since the render itself shows the layering.
const BOTTLE_IMAGE_2_LAYER = "https://cdn.shopify.com/s/files/1/1005/4379/1236/files/animated_bottle.png?v=1784530062";
const BOTTLE_IMAGE_3PLUS_LAYER = "https://cdn.shopify.com/s/files/1/1005/4379/1236/files/animated_bottle-3layered.png?v=1784530061";

/**
 * Creates the real Shopify product for a CONFIRMED FragranceRecommendation — never called until
 * recommendationConfirmation.server.js's confirmRecommendation has already re-verified everything
 * (products exist, notes exist, ratios sum to 100%, no high-severity conflict, combination is
 * still genuinely new). Every product, note, and ratio here comes straight from the immutable
 * recommendation record — nothing is re-derived or left to the model.
 */
async function createShopifyCustomCombinationProduct(admin, shopDomain, recommendation, customName, description, customerName, customerEmail) {
  const products = Array.isArray(recommendation.productsJson) ? recommendation.productsJson : [];
  const ratios = Array.isArray(recommendation.ratiosJson) ? recommendation.ratiosJson : [];
  const ratioByTitle = new Map(ratios.map(r => [r.productTitle, r]));

  // Real per-5ml pricing comes from the FragranceProduct catalog now, not a CSV.
  const catalogRows = await prisma.fragranceProduct.findMany({
    where: { normalizedTitle: { in: products.map(p => normalizeProductName(p.title)) } },
    select: { normalizedTitle: true, pricePer5ml: true }
  });
  const priceByNormalizedTitle = new Map(catalogRows.map(r => [r.normalizedTitle, r.pricePer5ml]));

  const componentDetails = products.map(p => {
    const ratio = ratioByTitle.get(p.title);
    if (!ratio) throw new Error(`No ratio found for product "${p.title}".`);
    const pricePer5ml = priceByNormalizedTitle.get(normalizeProductName(p.title));
    return {
      title: p.title,
      notes: Array.isArray(p.notes) ? p.notes : [],
      role: p.contribution || "",
      ratioPercent: ratio.ratioPercent,
      milliliters: ratio.milliliters,
      pricePer5ml: typeof pricePer5ml === "number" ? pricePer5ml : FALLBACK_PRICE_PER_5ML
    };
  });

  // Total price = each component's real per-5ml rate applied to however much of it went into the
  // blend (recommendationEngine.server.js already computed milliliters against a fixed 34ml bottle).
  const computedPrice = componentDetails.reduce(
    (sum, c) => sum + (c.pricePer5ml / 5) * c.milliliters,
    0
  );
  const FIXED_PRICE = computedPrice.toFixed(2);

  // A combination can have 2-4 real component products (Hybrid/Tribrid/Quadbrid), but Shopify caps
  // every product at 3 options total — unlike the old top/middle/base system (always exactly 3
  // positions), a single "Blend Composition" option naming every real product and its fixed ratio
  // works uniformly regardless of type, and never risks exceeding the cap.
  const blendValue = componentDetails.map(c => `${c.title} (${Math.round(c.ratioPercent)}%)`).join(" + ");
  const productOptions = [{ name: "Blend Composition", values: [{ name: blendValue }] }];

  const notesSummaryHtml = componentDetails
    .map(c => `<strong>${c.title}</strong> (${c.role}, ${Math.round(c.ratioPercent)}%): ${c.notes.slice(0, 6).join(", ")}`)
    .join("<br>");

  const fullDescription = `${description}` +
    `<p>${notesSummaryHtml}</p>` +
    `<p><strong>Type:</strong> ${recommendation.combinationType}</p>` +
    `<p><strong>Longevity:</strong> A rich, parfum-concentration blend crafted for long-lasting wear.</p>`;

  const createResponse = await admin.graphql(`
    mutation createProduct($input: ProductInput!) {
      productCreate(input: $input) {
        product { id handle }
        userErrors { field message }
      }
    }
  `, {
    variables: {
      input: {
        title: customName,
        descriptionHtml: fullDescription,
        vendor: customerName || customerEmail || undefined,
        status: "ACTIVE",
        templateSuffix: "custom-scent",
        productOptions,
        metafields: [
          {
            namespace: "custom",
            key: "note_composition",
            type: "json",
            value: JSON.stringify({
              recommendationId: recommendation.id,
              combinationType: recommendation.combinationType,
              components: componentDetails
            })
          },
          {
            // Admin-only by default (not exposed to the Storefront API) — keeps the customer's
            // name/email out of any public-facing page while still letting staff look up who a
            // custom product belongs to.
            namespace: "custom",
            key: "customer_name",
            type: "single_line_text_field",
            value: customerName || ""
          },
          {
            namespace: "custom",
            key: "customer_email",
            type: "single_line_text_field",
            value: customerEmail || ""
          }
        ]
      }
    }
  });

  const createJson = await createResponse.json();
  const product = createJson.data?.productCreate?.product;
  const createErrors = createJson.data?.productCreate?.userErrors;

  if (!product || (createErrors && createErrors.length > 0)) {
    throw new Error(createErrors?.map(e => e.message).join(", ") || "Product creation failed.");
  }

  // Custom-built products have no real product photo — without one, collection/search grids show
  // a blank placeholder box (as seen in "Your Design"). Attach the real bottle image hosted on
  // Shopify's own CDN — a different animation for a 2-component blend vs. a 3+ component one.
  const bottleImageUrl = componentDetails.length === 2 ? BOTTLE_IMAGE_2_LAYER : BOTTLE_IMAGE_3PLUS_LAYER;
  try {
    const mediaResponse = await admin.graphql(`
      mutation attachBottleImage($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          mediaUserErrors { field message }
        }
      }
    `, {
      variables: {
        productId: product.id,
        media: [{
          mediaContentType: "IMAGE",
          originalSource: bottleImageUrl,
          alt: customName
        }]
      }
    });
    const mediaJson = await mediaResponse.json();
    const mediaErrors = mediaJson.data?.productCreateMedia?.mediaUserErrors;
    if (mediaErrors && mediaErrors.length > 0) {
      console.error("productCreateMedia returned mediaUserErrors:", JSON.stringify(mediaErrors));
    }
  } catch (mediaErr) {
    console.error("Failed to attach bottle image:", mediaErr.message || mediaErr);
    // Don't fail the whole product just because the image attach failed.
  }

  // New products aren't published anywhere by default — publish to every sales channel the app
  // can see so the customer can actually buy it, not just view it in the admin.
  try {
    const publicationsResponse = await admin.graphql(`
      query getPublications {
        publications(first: 25) { nodes { id } }
      }
    `);
    const publicationsJson = await publicationsResponse.json();
    const publicationIds = publicationsJson.data?.publications?.nodes?.map(n => n.id) || [];
    console.log("Publications lookup:", JSON.stringify({ count: publicationIds.length, errors: publicationsJson.errors }));

    if (publicationIds.length > 0) {
      const publishResponse = await admin.graphql(`
        mutation publishToAllChannels($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) {
            userErrors { field message }
          }
        }
      `, {
        variables: {
          id: product.id,
          input: publicationIds.map(pubId => ({ publicationId: pubId }))
        }
      });
      const publishJson = await publishResponse.json();
      const publishErrors = publishJson.data?.publishablePublish?.userErrors;
      if (publishErrors && publishErrors.length > 0) {
        console.error("publishablePublish returned userErrors:", JSON.stringify(publishErrors));
      }
    }
  } catch (pubErr) {
    console.error("Failed to publish product to sales channels:", pubErr.message || pubErr);
    // Don't fail the whole product just because publishing failed — it'll just need publishing
    // manually in admin.
  }

  const variantsResponse = await admin.graphql(`
    query getVariants($id: ID!) {
      product(id: $id) { variants(first: 1) { edges { node { id } } } }
    }
  `, { variables: { id: product.id } });
  const variantsJson = await variantsResponse.json();
  const defaultVariantId = variantsJson.data?.product?.variants?.edges?.[0]?.node?.id;

  // Custom fragrances are made to order — there's no real stock count to track. Leaving the
  // variant untracked (Shopify's own default for a fresh variant) means it's always purchasable,
  // with no location/quantity bookkeeping needed at all.
  if (defaultVariantId) {
    await admin.graphql(`
      mutation setPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          product { id }
          userErrors { field message }
        }
      }
    `, {
      variables: {
        productId: product.id,
        variants: [{ id: defaultVariantId, price: FIXED_PRICE, inventoryItem: { tracked: false } }],
      },
    });
  }

  const cleanShopDomain = shopDomain.replace(/^https?:\/\//, '');
  const productUrl = `https://${cleanShopDomain}/products/${product.handle}`;

  // Records which real Shopify product this recommendation resulted in — keeps the immutable
  // FragranceRecommendation row linked to what was actually created from it.
  await markRecommendationShopifyProduct(recommendation.id, product.id);

  return { productUrl, totalPrice: parseFloat(FIXED_PRICE) };
}

// ============================================================
// 7. LOADER — handles history fetch (GET) requests
// ============================================================
// Every response below must carry the full CORS header set, not just Access-Control-Allow-Origin
// — verified directly against the live server (curl'd its real OPTIONS response) that React
// Router routes OPTIONS preflight requests to loader(), not action(), even though action() also
// has its own (dead-in-production) OPTIONS branch. Without Access-Control-Allow-Headers here,
// the browser's preflight silently fails and the actual POST to action() never gets sent at all.
const CHAT_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Shopify-Shop-Id, ngrok-skip-browser-warning",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CHAT_CORS_HEADERS });
  }

  const url = new URL(request.url);
  const isHistoryRequest = url.searchParams.get("history") === "true";
  const conversationId = url.searchParams.get("conversation_id");

  if (isHistoryRequest) {
    // Reuses the same DB-rehydration path as the AI's own conversation lookup, so a page reload
    // after a server restart shows the same history the AI itself will actually remember.
    const { history } = conversationId ? await getConversation(conversationId) : { history: [] };

    const messages = history
      .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim() !== "")
      .map(m => ({ role: m.role, content: m.content }));

    return new Response(JSON.stringify({ messages }), {
      status: 200,
      headers: { ...CHAT_CORS_HEADERS, "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ messages: [] }), {
    status: 200,
    headers: { ...CHAT_CORS_HEADERS, "Content-Type": "application/json" }
  });
}

// ============================================================
// 8. ACTION — handles incoming chat messages (POST)
// ============================================================
export async function action({ request }) {
  // Fire-and-forget warm-up so this DB scan starts on the first real request instead of
  // blocking it — getRegionMaps() caches internally, so this is a cheap no-op on every request
  // after the first. Deliberately called here (inside action, not at module top-level) — React
  // Router's production build only allows server-only imports like ../db.server to be referenced
  // from loader/action/middleware/headers; a bare top-level call at module scope broke the
  // Vite/Docker build with "Server-only module referenced by client" (verified locally via
  // `npm run build`).
  getRegionMaps();

  // Kept in sync with loader()'s CHAT_CORS_HEADERS — this OPTIONS branch is dead in production
  // (React Router routes OPTIONS to loader, not action; verified via direct curl against the
  // live server), but left here as a harmless fallback in case that routing behavior changes.
  const corsHeaders = CHAT_CORS_HEADERS;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await request.json();

    // Prefer the shop domain the theme block actually knows about (injected via Liquid as
    // {{ shop.permanent_domain }}) over guessing from the Origin header — Origin reflects
    // whatever's actually hosting the storefront request (e.g. a local theme preview port),
    // which isn't a valid shop domain and made `unauthenticated.admin()` reject it outright.
    const originHeader = request.headers.get("Origin") || "";
    const originShopDomain = originHeader.replace(/^https?:\/\//, '').split('/')[0];
    let shopDomain = body.shop_domain || originShopDomain;
    if (!shopDomain || !shopDomain.includes(".")) {
      shopDomain = "test-3d-products.myshopify.com";
    }
    console.log("Shop domain resolution:", JSON.stringify({ fromBody: body.shop_domain, fromOrigin: originShopDomain, resolved: shopDomain }));

    let admin = null;
    try {
      const result = await unauthenticated.admin(shopDomain);
      admin = result.admin;
      console.log("Successfully verified session credentials for:", shopDomain);
    } catch (authErr) {
      console.error("Admin verification session lookup failure:", authErr.message);
    }

    const userMessage = body.message || "";
    const { id: conversationId, history } = await getConversation(body.conversation_id);

    history.push({ role: "user", content: userMessage });

    // Provided by the storefront widget from the customer's real, logged-in Shopify account —
    // the theme extension now strictly gates chat behind {% if customer %}, so both of these
    // are expected to be present on every real request; the null fallbacks here are just
    // defensive, not an expected path.
    const knownCustomerEmail = typeof body.customer_email === "string" && body.customer_email.includes("@")
      ? body.customer_email.trim()
      : null;
    const knownCustomerName = typeof body.customer_name === "string" && body.customer_name.trim()
      ? body.customer_name.trim()
      : null;

    const { replyText, readyForShopifyCreation, sseEvents, updatedMessages } = await callAI(history, conversationId, knownCustomerEmail, knownCustomerName);

    CONVERSATIONS.set(conversationId, updatedMessages || history);

    // Durable copy in the DB alongside the in-memory CONVERSATIONS map that actually drives the
    // live conversation — conversationId is already the customer-facing session id (generated in
    // getConversation, returned to the widget via the "id" SSE event below, and sent back on every
    // subsequent request), so no separate sessionId is needed. Never let a DB hiccup break the
    // customer's actual reply.
    try {
      await createOrUpdateConversation(conversationId, knownCustomerEmail, knownCustomerName);
      await saveMessage(conversationId, "user", userMessage);
      await saveMessage(conversationId, "assistant", replyText);
    } catch (persistErr) {
      console.error("Failed to persist chat log:", persistErr.message);
    }

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

        send({ type: "id", conversation_id: conversationId });

        // Structured events collected from this turn's tool calls (Phase 14) — profile_progress,
        // analysis_progress/candidate_products, combination_recommendations,
        // recommendation_refined, recommendation_confirmed — sent before the chunk so the frontend
        // can render any recommendation cards alongside the accompanying conversational text.
        for (const event of sseEvents || []) {
          send(event);
        }

        send({ type: "chunk", chunk: replyText });
        send({ type: "message_complete" });

        if (readyForShopifyCreation) {
          const { recommendationId, customName, description } = readyForShopifyCreation;
          console.log("Combination confirmed, creating Shopify product for recommendation:", recommendationId);
          send({ type: "product_creating" });

          if (!admin) {
            const productError = "Product creation is unavailable right now (session handshake failed).";
            console.error(productError);
            send({ type: "product_error", error: productError });
          } else {
            try {
              const recommendation = await getRecommendation(recommendationId);
              const productResult = await createShopifyCustomCombinationProduct(
                admin, shopDomain, recommendation, customName, description, knownCustomerName, knownCustomerEmail
              );
              console.log("Combination product created successfully:", productResult.productUrl);
              send({ type: "product_created", url: productResult.productUrl, price: productResult.totalPrice });
            } catch (err) {
              console.error("Combination product creation failed:", err);
              send({ type: "product_error", error: err.message });
            }
          }
        }

        send({ type: "end_turn" });
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });

  } catch (err) {
    console.error("Action error:", err);
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: "Error processing request." })}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  }
}