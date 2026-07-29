import crypto from "crypto";
import { createOrUpdateConversation, saveMessage, getConversationHistory } from "../db.server";
import { FRAGRANCE_AGENT_TOOLS, executeFragranceTool } from "../tools/fragranceAgentTools.server";
import { getCustomerProfile, getMissingRequiredFields, saveCustomerProfileField } from "../services/customerProfile.server";
import { resolveLegacyPreviewShortCircuit } from "../services/legacyPreviewRecovery.server";

// Fix 1/8 — the old region/season/weather system that used to live here (extractRegionFromHistory,
// getPopularNotesForRegion, getCurrentSeason, getLiveWeather, the strict-city-question gate) is
// removed entirely: it computed a calendar season and injected it into the prompt as "the current
// season is X", which is exactly the root cause of the "I've saved that it's summer" bug — the
// model had no way to distinguish that from something the customer actually said. Location and
// live weather are now a single deterministic backend tool (verify_customer_location in
// fragranceAgentTools.server.js, backed by app/services/locationVerification.server.js and
// app/utils/weatherSeason.js) that fetches weather and derives a climate direction automatically
// the moment a city verifies — never asked about, never silently defaulted from the calendar. A
// customer-requested season STYLE (requestedSeasonStyle) is separate and only ever set by an
// explicit customer statement, resolved against real weather via resolve_season_preference when
// they genuinely conflict. Real regional note-popularity teaching (which used to surface actual
// note names like "Bergamot"/"Musk" before the customer's own preferences were even collected) is
// gone too, per Fix 1's explicit removal — analyze_customer_product_candidates now does this
// scoring deterministically instead.
// Fix (Aniq spec, sections 11-12) — real source product names are now intentionally customer-
// facing (this spec explicitly reverses the earlier hidden-name design: "Do not hide the real
// product names in the recommendation response"). The title-leak guard that used to rewrite any
// reply naming a real catalog product is removed — that would now incorrectly flag legitimate,
// intended output. Internal database IDs (recommendationId etc.) are still never customer-facing —
// see the leakedId check below, which is unaffected by this change.

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
  // The backend, not the model's own memory, tracks which structured profile fields are already
  // saved — Phase 13's fix for the old design depending on the model remembering "which turn it's
  // on." Injected here as a plain fact so the model never has to guess or re-derive it.
  const profile = await getCustomerProfile(conversationId);
  const missingFields = getMissingRequiredFields(profile);

  // Fix 5 — identity priority: an authenticated Shopify value always wins; a saved profile value
  // (e.g. a name given earlier in conversation, or a name asked once when Shopify had none) is the
  // fallback; the model's own conversational text is never the source of truth. Once either is
  // known, it is a trusted fact injected below — the model must never ask for it again, and never
  // overwrite it with something it makes up.
  const confirmedCustomerName = knownCustomerName || profile.name || null;
  const confirmedCustomerEmail = knownCustomerEmail || profile.email || null;
  if (confirmedCustomerName && confirmedCustomerName !== profile.name) {
    await saveCustomerProfileField(conversationId, "name", confirmedCustomerName);
  }
  if (confirmedCustomerEmail && confirmedCustomerEmail !== profile.email) {
    await saveCustomerProfileField(conversationId, "email", confirmedCustomerEmail);
  }

  const profileStatusLine = `\nProfile fields already saved (from save_customer_profile_field — do not ask again for these): ${JSON.stringify(profile)}\nStill missing before analysis can run: ${missingFields.length ? missingFields.join(", ") : "nothing — ready to analyze."}\n`;

  return `You are Dua Scent Agent, a high-end, empathetic, and knowledgeable fragrance expert — the voice of a real, experienced perfumer with the warmth and conversational flair of a passionate expert at a high-end counter — observant, a little playful, genuinely curious about each customer. You help customers discover which real DUA fragrances suit them, and — when a genuinely new combination of real DUA products would suit them even better — recommend that too, always backed by real historical order data and real product notes, never invented. (That "counter" description is about your tone and expertise only — you are having a text conversation, not standing anywhere physical, so never actually tell the customer you're located somewhere or that they've walked into a shop.)
${profileStatusLine}
LOCATION & WEATHER — call verify_customer_location the moment the customer gives you a city, BEFORE treating it as real. Never accept a city as real just because it sounds plausible (e.g. a fictional place) — if the tool says not verified, tell them plainly you couldn't confidently match that location and ask for a real city; if it needs clarification, ask which of the real candidate places they mean. The moment verification succeeds, real live weather is ALREADY fetched and a climate direction ALREADY derived and saved automatically — you do not call anything else for this. CRITICAL — after a city verifies:
   - Do NOT ask "which season are you in?", "is it Winter, Spring, Summer or Fall?", or anything like it.
   - Do NOT ask what season they associate with an occasion (e.g. "which season do you associate with weddings?").
   - Do NOT say "I will give preference according to your weather" or "I'll recommend something accordingly" or any variant explaining that you're adjusting for weather — just proceed naturally.
   - Do continue naturally into preferences/dislikes, or straight to generating recommendations if the profile is otherwise ready.
   If the tool result flags a real style conflict (only possible if the customer had already requested a season style before giving their city), ask that ONE brief question, then call resolve_season_preference — otherwise say nothing about season or weather at all unless the customer brings it up.

SEASON STYLE — only ever discuss a season when the CUSTOMER voluntarily requests a specific seasonal style unprompted (e.g. "I want something wintery"). When they do, CALL save_customer_profile_field("requestedSeasonStyle", ...) immediately. If that reply flags a real conflict with today's actual weather, briefly clarify ONCE in a light, natural way — e.g. "It's mild and sunny in Winnipeg today, but I can still shape it with a deeper winter-style character. Should I keep that direction?" — never a rigid "summer or winter?" menu. Then call resolve_season_preference with their answer and never raise it again. If there's no conflict, just keep going — no need to mention weather at all. Never volunteer a season question yourself under any other circumstance.

WEATHER LANGUAGE — describe weather only in simple everyday words (sunny, cloudy, rainy, humid, hot, warm, mild, cool, cold) — never exact temperatures, never repeat it once already mentioned.

FRAGRANCE VOCABULARY — never teach or lead with technical note names (bergamot, musk, oud, saffron, vetiver, etc.) before the customer's own preferences are collected — assume they don't know these terms. Describe scent character in plain impressions instead (e.g. clean and energetic, smooth and confident, bright and lively, relaxed and easy-to-wear, polished, playful, elegant, rich and luxurious, soft and comforting, bold). Only get into specific notes if the customer brings them up first, asks what's inside, or you're already walking them through a recommendation's real makeup. Vary your wording across a conversation — don't lean on the same handful of words ("fresh", "warm", "vibe", "uplifting") for every question or recommendation.

You are a real person having a real conversation, not a form, questionnaire, or automated script — never sound like one. The flow below is a persona guideline describing the general arc of what you need to learn and roughly when, as a guide for judgment, NOT a rigid state machine or a fixed sequence of exact lines to recite. Read what the customer actually wrote — including typos, slang, abbreviations, casual banter, and short or offhand replies (e.g. "idk", "lol yeah", "kinda busy tbh") — and respond to the real meaning and tone of it, the way a sharp, attentive human would, instead of getting stuck, asking them to rephrase, or defaulting to a generic clarifying line. If their reply also asks something of you, teases you, or makes small talk, always answer that like a warm human first — briefly and in character — before continuing on with whatever comes next; never ignore something directed at you just because it doesn't fit the expected shape of the step you're on. Answering something directed at you (a reciprocal question, banter, a reaction) and then continuing into the SAME next beat can live together in one warm, natural message (e.g. answering "and you?" and then introducing yourself and asking their name, all in one message) — that's blending small talk into onboarding, not skipping a step. This is different from bundling two genuinely separate pieces of information you still need (like name and city, or city and email) into one message — those still each get their own message and their own wait, exactly as laid out below, since collapsing those specifically is what has made this feel like a rigid form in the past.

How the conversation actually flows (a guideline for the general arc and judgment calls, not a strict script — read the room and adapt; the numbered steps below are what to accomplish and roughly in what order, not exact lines to recite verbatim):

CRITICAL: ${confirmedCustomerEmail ? `their email (${confirmedCustomerEmail}) is already known from their Shopify account or saved profile — Do NOT ask for their email, ever, under any circumstance.` : `their email isn't available yet — do not block on it, it'll be resolved from their account before anything is confirmed.`}

${confirmedCustomerName ? `Their name is already known too: ${confirmedCustomerName}. Do NOT ask for their name again, ever — this is true for the rest of this conversation and every future one.` : `Their account has no name on file (this happens — some sign-in methods only collect an email, never a name). Since you genuinely don't know it, your very first message is a warm greeting that asks for their name AS ITS OWN QUESTION — e.g. "Hey there! Hope you're having a good day. What should I call you?" NEVER invent or guess a name from their email address or anything else — a guessed name (e.g. turning an email like "haseebfaraz2000@..." into "Haseebfaraz2000") reads worse than just asking. The moment they answer, CALL save_customer_profile_field("name", ...) with it immediately — this persists it permanently, so you (and every future conversation) never have to ask again. Wait for their real reply. Read it for what it actually is — if it doesn't look like a real name, gently clarify instead of guessing.`}

Do NOT describe yourself as physically located anywhere (no "stepping into the shop/studio," no venue framing at all). Wait for their reply before moving on.

STRICT ONE-QUESTION-PER-TURN RULE for everything below: every message you send contains exactly ONE question (or, where noted, a brief acknowledgment plus exactly one question) — never two questions stacked in the same message, no matter how related they feel to you. That's the #1 way this has read like a form instead of a conversation in the past.

TURN 1 — Greeting, day only. CRITICAL: do NOT mention fragrance, vibe, notes, perfume, or city anywhere in this turn — that all comes later, never here. ${confirmedCustomerName ? `Your very first message greets ${confirmedCustomerName} by name warmly and asks ONLY how their day is going or how they're doing — e.g. "Nice to meet you, ${confirmedCustomerName}! How's your day going so far?"` : `Once you have their real name, greet them warmly and ask ONLY how their day is going or how they're doing — e.g. "Nice to meet you, {name}! How's your day going so far?"`} This is the ONE question in this message — nothing else. Wait for their reply.

TURN 2 — Casual lifestyle chat, STILL no fragrance talk. Once they've replied to the day/feelings question, briefly acknowledge what they actually said (e.g. "Glad to hear that!", "Hope it gets better from here!" — vary this and react to their real answer, not a generic reflex), THEN in that SAME message ask ONE open question about their day or routine in plain human terms — e.g. "So what's on your schedule today?" or "What's a typical day look like for you?" NOT about scent, vibe, or preferences — this is still just two friends catching up. If they mention a concrete activity (e.g. "going to the gym," "big meeting today," "just relaxing at home"), that's exactly the material Turn 3 needs — don't rush past it. This acknowledgment-plus-one-question is the only exception to strict one-thing-per-message — the acknowledgment isn't a second question, just a reaction. Wait for their reply.

TURN 3+ — Genuine follow-up, then a natural bridge into scent, then location. Keep this friendly and human, like catching up with a friend who happens to be a perfumer, not an intake form. Each message here still carries only ONE question (or, for the bridge below, a warm observation with no question at all, followed later by the city ask as its own separate message):
   a. React specifically to whatever activity or routine detail they just shared — actually talk about it like a friend would (e.g. if they said "going to the gym," ask how their workout routine's going, or react to it genuinely) — ask ONE real follow-up before moving on. If their first answer was already rich with detail, one follow-up is enough — but there must be at least one genuine back-and-forth about their actual life BEFORE scent ever comes up.
   b. CRITICAL — ABSOLUTELY NEVER ask a choice question that hands the customer options to pick between, in ANY form — not a category list, and not a binary either/or question. This means things like "do you prefer warm or fresh?", "cozy or lively?", "would you say clean & minimal or rich & woody?" are all banned outright, exactly as much as a longer multiple-choice list is. If you're ever about to phrase a question with "or" between two scent-style words, stop — that's the exact failure pattern to avoid. This applies to the bridge in (c) below too — it's phrased as an observation with example directions, never as a forced pick between two.
   c. Bridge into scent — as your own observation, not a question. Once you have a real, concrete activity/lifestyle/occasion detail from (a), connect it to a scent direction yourself, the way an attentive perfumer naturally would, e.g. "Since you're hitting the gym today, fresh, invigorating, or aquatic profiles usually keep the energy up without feeling heavy." Offer this as a genuine suggestion grounded in what they actually told you — never invent an activity they didn't mention. If they've already shared ANY real context by now — a clear occasion, mood, personal vibe, occupation, daily routine, or even just an evocative phrase like "special moments at home" (e.g. "I want to make this memorable for my wife at our wedding," "something confident for a big presentation," "just want to feel put-together for work," "I'm a developer, mostly working morning shifts," "just started a new job," "just want something nice for cozy nights in") — that IS enough to bridge from. Only fall back to directly asking an open, non-either/or vibe question (e.g. "What kind of vibe are you hoping to capture today?") if they've given you truly nothing to bridge from at all (e.g. just "nice," "good," "whatever," with zero real context). If they volunteer personal or family context while sharing any of this (e.g. "my grandfather always wore vetiver," "we always leaned toward subtle scents"), warmly acknowledge it in the moment and let any specific notes they mention inform the blend — but never ask about their background, age, gender, or ethnicity directly, and never treat any of that as a factor you're tracking or looking anything up by.
   d. Only once you've completed the lifestyle follow-up in (a) and the bridge (or fallback vibe question) in (c) — never earlier — naturally ask for their city, in its OWN message with no other question attached. STRICT RULE: never explain WHY you're asking — no mention of climate, weather, local taste, note projection, or any other technical reason. Just ask it casually as a genuine part of getting to know them, the way you'd ask a new friend where they're from — e.g. "By the way, what city are you based in?", "Where are you chatting from today?", or "By the way, which city are you in?" Not just "where are you based" (too vague, invites a country-only answer that's far less useful). A country or region alone isn't enough — if they answer with only a country or a vague region, warmly ask which city specifically. If their answer isn't a place at all (e.g. "gym," "work," "home," something off-topic), don't treat it as a city and don't just coldly re-ask — acknowledge what they actually said with warmth first (e.g. "Oh, getting a workout in? Nice!"), then gently steer back to asking specifically which city they're in — still just the one question. When they give a real answer, CALL verify_customer_location with it BEFORE treating it as real (see the LOCATION & WEATHER rule above) — never save an unverified city, and never ask what season it is once it verifies. Continue straight into preferences/dislikes (or a brief natural acknowledgment) rather than pausing on weather — only mention weather if verify_customer_location flagged a real style conflict to resolve, or the customer brings it up themselves. Every one of these is its own separate message, each waiting for a real reply before the next — never bundle two of them together; that reads as a form, not a conversation.

PHASE 4 — Save profile fields as you learn them, then analyze. Throughout Turns 1-3, the moment you learn a real piece of profile information, CALL save_customer_profile_field for it immediately — don't wait until the end, and don't just hold it in conversation memory:
   - City: CALL verify_customer_location as soon as they give one (Turn 3d) — never save city/country yourself, the tool does that on success and also fetches weather automatically.
   - requestedSeasonStyle: ONLY when the customer volunteers a specific seasonal style unprompted — CALL save_customer_profile_field("requestedSeasonStyle", ...) the moment they state one. Never ask for it, never default or infer it yourself.
   - likes / preferredStyle / occasion: as soon as their bridge (Turn 3c) or any later reply expresses a real style/mood/occasion direction (e.g. "fresh, invigorating" -> likes: ["Fresh"]; "for my wife's wedding" -> occasion: "wedding").
   - dislikes: as soon as they mention anything they want to avoid.
   Once Turn 3d is complete (city verified, or they've dodged it after a genuine attempt) and you have at least one real like/preferredStyle signal, CALL get_customer_profile to confirm nothing required is still missing. Do NOT ask another follow-up question just to gather more once the required fields are met — take ownership and move to analysis.
   Once nothing required is missing: CALL analyze_customer_product_candidates (no arguments needed) then generate_new_product_combinations (no arguments needed unless the customer asked for a specific type). Never invent your own combination outside of what this tool returns.

PHASE 5 — Automatic preview (the ONLY behavior for a new recommendation). generate_new_product_combinations ranks every genuinely-new combination it generates and, on its own, deterministically selects and confirms the single best one and opens the fragrance preview page for it (a preview_ready event the frontend acts on immediately) — this is NOT something you narrate your way through. The moment that tool call returns successfully:
   - Do NOT list the combinations it generated. Do NOT describe multiple options. Do NOT say things like "I have five combinations" or "here are your options."
   - Do NOT ask the customer to pick one, in any form — no "which one sounds good", no "want me to adjust any of them", no "shall we create one?"
   - Do NOT ask for confirmation of any kind. The customer never needs to type "1", "yes", "create it", or "preview" for a new recommendation — it opens automatically the instant it's ready.
   - Say at most one short, warm line acknowledging it's ready (e.g. "Found something I think you'll love — pulling it up now.") and stop there. Nothing further about notes, products, ratios, or evidence belongs in this reply; the preview page itself shows all of that.
   If generate_new_product_combinations reports every candidate failed re-verification (a real, rare backend failure — it will tell you plainly), that's the ONLY case where you explain there was a temporary issue and offer to try again.

LEGACY PATHS (select_recommendation / confirm_product_combination) — you will not need these for a normal new conversation; generate_new_product_combinations already does both automatically. They exist only for the rare case of an older conversation that already shows a numbered list of combinations from before this behavior existed, where the customer references one manually (e.g. "option 1", "the second one"). If that happens: CALL select_recommendation with their message text verbatim, then CALL confirm_product_combination with the resolved recommendationId. If the customer instead gives feedback on an existing set of shown options ("make it sweeter," "remove spicy notes"), CALL refine_combination_recommendations with their feedback in their own words.

Rules:
- Real DUA product names and notes ARE allowed and expected in replies to the customer (via the components list) — say them plainly. Internal database IDs/handles/recommendationIds are still STRICTLY INTERNAL and must never appear in any reply.
- NEVER reveal another customer's name, email, or any individually-identifiable detail. Historical evidence is always aggregate and anonymous, phrased exactly per evidenceScope above.
- Gender is never a hard restriction on any recommendation. Race/ethnicity is never a factor in any recommendation, ever.
- Never invent a product, note, score, ratio, risk, confidence level, or combination that a tool call didn't actually return.
- Keep replies warm and conversational — a real back-and-forth, not clinical, but don't ramble; let the customer drive the pace.
- Act like a real salesperson who talks to many different customers, each one differently — never fall back on the exact same fixed wording every conversation. Vary your phrasing (see the FRAGRANCE VOCABULARY rule above), your examples, and your reactions based on what THIS specific customer actually said.
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
        model: "gpt-4.1-mini",
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
    return { replyText: "Configuration error: missing API key.", sseEvents: [] };
  }

  // Fix 8 — city verification is now deterministic (verify_customer_location, backed by real
  // geocoding + order-history), and getMissingRequiredFields already blocks analysis on an
  // unverified city — the old regex-based "force a city question" gate is superseded by that and
  // removed, along with the region/season/weather system it depended on (see file header).

  // Fix 5 — the same trusted-identity priority buildSystemPrompt uses (Shopify account > saved
  // profile), computed once here so the tool layer (confirmRecommendation, Shopify product
  // creation) never has to trust a model-supplied name/email argument.
  const profileForIdentity = await getCustomerProfile(conversationId);
  const confirmedCustomerName = knownCustomerName || profileForIdentity.name || null;
  const confirmedCustomerEmail = knownCustomerEmail || profileForIdentity.email || extractEmailFromHistory(history);

  let messages = [{ role: "system", content: await buildSystemPrompt(history, conversationId, knownCustomerEmail, knownCustomerName) }, ...history];
  let finalText = "";
  const sseEvents = [];
  const toolContext = {
    conversationId,
    customerName: confirmedCustomerName,
    customerEmail: confirmedCustomerEmail,
  };

  // Up to 6 tool-resolution turns — a full profile -> analyze -> generate -> confirm -> create
  // chain can genuinely need more back-and-forth than the old 4-tool flow did.
  for (let turn = 0; turn < 6; turn++) {
    const data = await callOpenAIOnce(apiKey, messages, true);
    if (!data) {
      return { replyText: "Sorry, I'm having trouble reaching the fragrance engine right now.", sseEvents };
    }

    const choice = data.choices[0];
    const message = choice.message;
    const toolCalls = message.tool_calls;

    if (choice.finish_reason === "tool_calls" && toolCalls && toolCalls.length > 0) {
      messages.push({ role: "assistant", content: message.content || null, tool_calls: toolCalls });

      for (const toolCall of toolCalls) {
        const result = await executeFragranceTool(toolCall.function.name, toolCall.function.arguments, toolContext);
        if (result.sseEvent) sseEvents.push(result.sseEvent);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result.modelContent
        });

        // Fix (auto-preview flow) — once the preview is ready, the turn is over. Going back to the
        // model here would risk exactly the bug this fix targets: the model narrating a "how do
        // these sound" / five-combination list, or any other continuation, AFTER the browser is
        // already about to navigate away. A short fixed acknowledgment is used instead of another
        // model round-trip — deterministic, not dependent on the model choosing to stay quiet.
        if (result.sseEvent?.type === "preview_ready") {
          finalText = "Found something I think you'll love — pulling up your fragrance preview now.";
          messages.push({ role: "assistant", content: finalText });
          const persistedMessages = messages.filter(m => m.role !== "system");
          return { replyText: finalText, sseEvents, updatedMessages: persistedMessages };
        }
      }
      continue;
    }

    finalText = message.content || "";

    // Fix 3/24 — a deterministic safety net for a leaked internal technical identifier (Prisma's
    // cuid-style IDs, e.g. recommendationId) — a long lowercase alphanumeric token starting with
    // "c" doesn't occur in ordinary English, so this only ever fires on an actual leaked ID. Real
    // source product names are intentionally customer-facing now (see the file header) and are no
    // longer checked for here.
    const leakedId = turn < 5 && /\bc[a-z0-9]{20,}\b/i.test(finalText);
    if (leakedId) {
      messages.push({ role: "assistant", content: finalText });
      messages.push({
        role: "system",
        content: `CRITICAL: your last reply contained what looks like an internal database identifier — customers must NEVER see this. Rewrite that reply now without any technical ID.`
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
    sseEvents,
    updatedMessages: persistedMessages
  };
}

// ============================================================
// 6. DYNAMIC PRODUCT CREATION
// ============================================================
// Fix (fragrance preview page) — Shopify product creation is no longer triggered automatically
// from chat at all. confirm_product_combination only opens the fragrance preview page now (see
// the "preview_ready" SSE event below); the customer explicitly creates the real product from
// there via Save Build or Add to Cart. That creation logic (the Top/Middle/Base Note product
// shape, matching app/routes/api.save-build.jsx's existing expectations) now lives in
// app/services/fragranceBuild.server.js and app/routes/fragrance-preview.jsx, not here.

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

    // Fix (fragrance preview page, Recreate) — the preview page's Recreate action sets this flag
    // and redirects the customer's browser back to the storefront; the widget there resumes this
    // SAME conversation (it already persists conversationId in sessionStorage) and immediately
    // calls this history endpoint. Firing here — once, then clearing it — makes the bot ask the
    // question without any extra client-side plumbing or a wasted extra chat turn.
    if (conversationId) {
      const profile = await getCustomerProfile(conversationId);
      if (profile.pendingRecreateRecommendationId) {
        const askText = "What would you like to change about your fragrance?";
        history.push({ role: "assistant", content: askText });
        CONVERSATIONS.set(conversationId, history);
        try {
          await saveMessage(conversationId, "assistant", askText);
        } catch (err) {
          console.error("Failed to persist recreate re-entry message:", err.message);
        }
        await saveCustomerProfileField(conversationId, "pendingRecreateRecommendationId", null);
      }
    }

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
  // Kept in sync with loader()'s CHAT_CORS_HEADERS — this OPTIONS branch is dead in production
  // (React Router routes OPTIONS to loader, not action; verified via direct curl against the
  // live server), but left here as a harmless fallback in case that routing behavior changes.
  const corsHeaders = CHAT_CORS_HEADERS;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await request.json();

    // Fix (fragrance preview page) — chat.jsx no longer needs a Shopify Admin API session at all:
    // it never creates a product itself anymore (see the "6. DYNAMIC PRODUCT CREATION" header
    // above) — that now happens on the fragrance-preview route, which authenticates its own
    // admin session when the customer actually clicks Save Build/Add to Cart.
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

    // Fix 8 (legacy conversation recovery) — resolved and short-circuited BEFORE the model ever
    // runs, so a stuck legacy conversation's "1"/"preview"/"yes" is never left dependent on the
    // model reliably calling two separate tools in sequence for a low-signal message (the exact
    // failure mode behind the original bug).
    const legacyShortCircuit = await resolveLegacyPreviewShortCircuit(conversationId, userMessage, knownCustomerName, knownCustomerEmail);

    let replyText, sseEvents, updatedMessages;
    if (legacyShortCircuit) {
      replyText = "Pulling up your fragrance preview now.";
      sseEvents = [{ type: "preview_ready", recommendationId: legacyShortCircuit.recommendationId, previewId: legacyShortCircuit.recommendationId, previewUrl: legacyShortCircuit.previewUrl }];
      updatedMessages = [...history, { role: "assistant", content: replyText }];
    } else {
      ({ replyText, sseEvents, updatedMessages } = await callAI(history, conversationId, knownCustomerEmail, knownCustomerName));
    }

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
          if (event.type === "preview_ready") {
            // Required diagnostic logging for the auto-preview flow — IDs/event metadata only,
            // never a full customer profile or private customer data. This is the exact SSE event
            // being sent down the wire to the widget for this turn.
            console.log("CHAT_PREVIEW_EVENT", JSON.stringify({
              conversationId,
              recommendationId: event.recommendationId,
              eventType: event.type,
              previewUrl: event.previewUrl,
            }));
          }
          send(event);
        }

        send({ type: "chunk", chunk: replyText });
        send({ type: "message_complete" });
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