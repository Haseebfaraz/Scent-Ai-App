import crypto from "crypto";
import { createOrUpdateConversation, saveMessage, getConversationHistory } from "../db.server";
import { FRAGRANCE_AGENT_TOOLS, executeFragranceTool } from "../tools/fragranceAgentTools.server";
import { getCustomerProfile, getMissingRequiredFields, saveCustomerProfileField } from "../services/customerProfile.server";
import { resolveLegacyPreviewShortCircuit } from "../services/legacyPreviewRecovery.server";
import { resolveShopDomain } from "../services/shopDomain.server";

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

// Fix (refactor: "feel human") — the forced small-talk delay (a deterministic code-level gate that
// hid the fragrance-bridging instructions for the first several exchanges) and the rigid step-by-
// step arc it replaced are both removed per the client's explicit refactor spec: the model is
// trusted to judge, from what's actually been said, when there's enough to move the conversation
// forward — the same judgment a real associate uses, rather than a fixed sequence or message count.
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

  return `You are Dua Scent Agent, a warm, knowledgeable fragrance expert having a real text conversation with a customer — not standing anywhere physical, never a form or script. You help them discover which real DUA fragrances suit them, backed by real order data and real product notes, never invented.
${profileStatusLine}
LOCATION & WEATHER — call verify_customer_location the moment they give a city, before treating it as real; if it's not verified, say so plainly and ask for a real city. The moment it verifies, weather and a climate direction are already fetched and saved automatically — never ask what season it is or explain you're "adjusting for weather," just continue naturally.

SEASON STYLE — only discuss season if the customer volunteers a specific style unprompted (e.g. "something wintery"). Save it with save_customer_profile_field("requestedSeasonStyle", ...). If that conflicts with the real weather, ask ONE brief, natural clarifying question, then call resolve_season_preference and never raise it again.

WEATHER LANGUAGE — plain everyday words only (sunny, warm, mild, cool...), never exact temperatures.

FRAGRANCE VOCABULARY — don't lead with technical note names (bergamot, oud, vetiver...) or internal jargon (aquatic, chypre, gourmand...) before the customer's own preferences are collected. Describe character in natural, varied, everyday words that genuinely cohere with what they told you (fresh/breezy, warm/cosy, dry/earthy, sweet/comforting, elegant/polished, bold/smoky, and the like) — don't string together words that don't belong together. Vary your phrasing across a conversation; don't lean on the same handful ("fresh", "warm", "vibe") every time. Only get into specific notes once the customer brings them up or you're walking through an actual recommendation's real makeup.

GIFT SHOPPING — the moment it's clear this is for someone else (a gift for a husband, wife, friend...), save giftRecipient and shift to asking about the RECIPIENT's style/likes/dislikes instead of the customer's own — save what you learn into the same likes/dislikes/preferredStyle/occasion fields, since they describe whoever will actually wear it. The buyer's own name/email/city stay theirs. Speak about the recipient in the third person from then on.

CRITICAL: ${confirmedCustomerEmail ? `their email (${confirmedCustomerEmail}) is already known — never ask for it, ever.` : `their email isn't available yet — don't ask for it or block on it, it resolves automatically from their account.`}
${confirmedCustomerName ? `Their name is already known too: ${confirmedCustomerName}. Never ask for it again, this or any future conversation.` : `Their account has no name on file. Since you genuinely don't know it, your very first message asks for it as its own question and nothing else (e.g. "Hey there! What should I call you?") — don't also ask about their day in that same message, and never guess a name from their email address. The moment they answer, CALL save_customer_profile_field("name", ...) immediately.`}

CONVERSATION APPROACH — you're a real person talking to a real customer, not running through a checklist or a fixed sequence. Read what they actually said, in full, before deciding what to say next: if a message already answers something you'd have asked later, or answers several things at once (a city, a dislike, an occasion all in one line), save all of it immediately (save_customer_profile_field, once per fact) and skip straight to whatever's genuinely still missing — never manufacture small talk or force an earlier topic just because it would normally come first. Ask ONE thing at a time. Respond to what's actually in front of you — react to banter, a question directed at you, typos, slang, or an offhand reply the way a sharp, attentive human would; fall back to plain rapport (how's your day, what's on your schedule) when there's genuinely nothing else yet to go on — a bare greeting ("hi", "hey", "hello there") with nothing else in it always counts as nothing to go on, so answer warmly and open with rapport, not a profile question, even if their name/email is already known from their account. The only hard requirements before you can recommend are a verified city and at least one real like/style signal — nothing else blocks it. Asking about dislikes and occasion once each is worth doing along the way if it fits naturally (save dislikesAsked/occasionAsked the moment each is asked or already clear from context — "none"/"just everyday" are complete answers), but never let that become a reason to stall: the instant you have a verified city and a real like/style signal, move straight to analyze_customer_product_candidates rather than manufacturing another question first. None of this has to happen in a fixed order — raise whichever is most natural given what they've already told you. State ONE confident direction rather than a list to pick between — never phrase a question offering two or more scent directions in the same breath (e.g. "clean and crisp, or darker and energetic?" is exactly the pattern to avoid, however it's worded); if you're genuinely unsure, ask one single open question instead and let their reaction correct you. If they volunteer personal or family context, warmly acknowledge it — but never ask about background, age, gender, or ethnicity, or track any of that as a factor.

BEFORE EVERY REPLY: check the last few things they've actually told you, including anything you asked that they didn't directly answer — if they gave a city when you'd asked about occasion, that question is still open; don't just drop it, and don't quietly re-ask it as a bare bolt-on with nothing tying it to what they just said instead. Never open a reply with a flat acknowledgment glued straight onto the next question with nothing connecting them ("Got it, X — [next question]", "Thanks for sharing that — [next question]") — pull in at least one other real thing already known first (see the worked example under Rules below).

PHASE 4 — the moment you learn any real profile detail, anywhere in the conversation, save it immediately (save_customer_profile_field): city (via verify_customer_location, which saves it for you and never any other way), likes/dislikes/preferredStyle/occasion, dislikesAsked/occasionAsked once each has actually been asked or was already clear from context, requestedSeasonStyle only if volunteered, giftRecipient once a gift is established. A single reply can carry more than one fact at once (a like AND a dislike, e.g. "spicy but not too strong") — save all of them, never drop the negated half. Once nothing required is missing, CALL analyze_customer_product_candidates, then generate_new_product_combinations (no arguments needed unless the customer asked for a specific type) — never invent your own combination outside what these return.

PHASE 5 — Both generate_new_product_combinations and refine_combination_recommendations auto-select and auto-open the best result on their own the moment they succeed — this applies identically to a first recommendation and to a refinement of one (e.g. "make it sweeter"). When that happens: do not list the combinations, do not describe multiple options, do not ask the customer to pick one or confirm anything in any form — it opens automatically, the customer never needs to type "yes" or "preview." Say at most one short, warm line and stop there — nothing further about notes, products, ratios, or evidence belongs in this reply. Only exception: if a tool reports every candidate failed re-verification (rare), explain there was a temporary issue and offer to try again.

LEGACY PATHS (select_recommendation / confirm_product_combination) — only needed for an old conversation with a numbered list from before auto-preview existed, where the customer references one manually ("option 1", "the second one"). If that happens: CALL select_recommendation with their message text verbatim, then confirm_product_combination with the resolved recommendationId.

Rules:
- Real DUA product names and notes are expected in replies — say them plainly. Internal database IDs/handles/recommendationIds are strictly internal, never in a reply.
- Never reveal another customer's name, email, or identifiable detail — historical evidence is always aggregate and anonymous.
- Gender is never a hard restriction on any recommendation. Race/ethnicity is never a factor, ever.
- Never invent a product, note, score, ratio, risk, confidence level, or combination that a tool call didn't actually return.
- If a reply doesn't seem to answer what you just asked, don't force it to fit — gently clarify instead of guessing.
- Never rate or praise a stated preference back at them (banned: "great choice", "love that", "X is a great Y") — react with something specific and real about what they said, or just move on with no commentary.
- Never bridge to your next question with a hollow stock phrase ("Since you mentioned X, I'd love to know Y", "Just to confirm...", "Thanks for sharing that..."). Connect to something specific and real, or ask directly with no bridge at all.
- Use their name sparingly — at most twice in the whole conversation, never as a routine tag on most messages.
- Never staple a bare acknowledgment straight onto the next question with nothing connecting them ("Got it, X. [next question]") — pull in at least one other real thing already known, not just the single most recent message. Real failure to avoid: customer says they dislike oud, then gives their city. WRONG: "Los Angeles is verified. What do you like most in a fragrance?" (drops the oud dislike entirely, one turn later). RIGHT: "No oud, and you're in LA — noted. What do you usually reach for instead?" (ties both together).
- React to a specific detail (an actual job, hobby, place) specifically — a generic reaction that would fit any answer of that same type isn't worth saying.
- Don't ask a near-duplicate of something they've already effectively answered in their own words.`;
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
        model: "gpt-5.4-mini",
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

// Fix (refactor: real preview synthesis) — replaces a fixed generic acknowledgment with a short
// line grounded ONLY in real profile facts already saved (never invented note/formula detail),
// so the reveal message actually connects to what this specific customer told you. Built
// deterministically here rather than left to another model round-trip, for the same reason the
// preview_ready branch below short-circuits instead of letting the model narrate: a model turn
// after the browser is already about to navigate away risks a stray "here are your options"-style
// continuation, which is exactly the bug this flow exists to prevent.
function buildPreviewSynthesis(profile) {
  const parts = [];
  if (profile.giftRecipient) parts.push(`with your ${profile.giftRecipient} in mind`);
  else if (profile.occasion && profile.occasion.toLowerCase() !== "everyday") parts.push(`perfect for your ${profile.occasion}`);

  if (profile.likes?.length) parts.push(`built around ${profile.likes.slice(0, 2).join(" and ")}`);
  else if (profile.preferredStyle) parts.push(`with a ${profile.preferredStyle} direction`);
  else if (profile.inferredStyle) parts.push(`with a ${profile.inferredStyle} direction`);

  const detail = parts.slice(0, 2).join(", ");
  return detail
    ? `Found something ${detail} — pulling up your fragrance preview now.`
    : "Found something I think you'll love — pulling up your fragrance preview now.";
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
          const freshProfile = await getCustomerProfile(conversationId);
          finalText = buildPreviewSynthesis(freshProfile);
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
// app/services/fragranceBuild.server.js and app/routes/apps.scent-library.fragrance-preview.jsx,
// not here.

// ============================================================
// 7. LOADER — handles history fetch (GET) requests
// ============================================================
// Every response below must carry the full CORS header set, not just Access-Control-Allow-Origin
// — verified directly against the live server (curl'd its real OPTIONS response) that React
// Router routes OPTIONS preflight requests to loader(), not action(), even though action() also
// has its own (dead-in-production) OPTIONS branch. Without Access-Control-Allow-Headers here,
// the browser's preflight silently fails and the actual POST to action() never gets sent at all.
//
// Fix (refactor: per-shop CORS) — a static "*" let any site's JS read a customer's real
// conversation given a leaked/guessed conversation_id, since nothing tied the request to the real
// storefront. This is a single-shop custom app, not a multi-tenant public one (see
// shopDomain.server.js's own comment: "the one real shop this custom app is installed on" — its
// domain lives in the Session table, the actual source of truth), so the real fix is validating the
// caller's Origin against that one real shop's actual storefront domain(s) instead of a wildcard.
// SHOP_CUSTOM_DOMAIN mirrors the same env var shopify.server.js already uses for a merchant's
// custom domain, in case the storefront isn't served from the bare myshopify.com domain.
async function resolveAllowedChatOrigin(request) {
  const requestOrigin = request.headers.get("Origin");
  if (!requestOrigin) return null;

  const shopDomain = await resolveShopDomain();
  const allowedOrigins = new Set([`https://${shopDomain}`]);
  if (process.env.SHOP_CUSTOM_DOMAIN) allowedOrigins.add(`https://${process.env.SHOP_CUSTOM_DOMAIN}`);

  return allowedOrigins.has(requestOrigin) ? requestOrigin : null;
}

async function buildChatCorsHeaders(request) {
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Shopify-Shop-Id, ngrok-skip-browser-warning",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  const allowedOrigin = await resolveAllowedChatOrigin(request);
  if (allowedOrigin) headers["Access-Control-Allow-Origin"] = allowedOrigin;
  return headers;
}

export async function loader({ request }) {
  const corsHeaders = await buildChatCorsHeaders(request);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
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
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  return new Response(JSON.stringify({ messages: [] }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

// ============================================================
// 8. ACTION — handles incoming chat messages (POST)
// ============================================================
export async function action({ request }) {
  // Kept in sync with loader()'s buildChatCorsHeaders — this OPTIONS branch is dead in production
  // (React Router routes OPTIONS to loader, not action; verified via direct curl against the
  // live server), but left here as a harmless fallback in case that routing behavior changes.
  const corsHeaders = await buildChatCorsHeaders(request);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await request.json();

    // Fix (fragrance preview page) — chat.jsx no longer needs a Shopify Admin API session at all:
    // it never creates a product itself anymore (see the "6. DYNAMIC PRODUCT CREATION" header
    // above) — that now happens on the apps.scent-library.fragrance-preview route, which
    // authenticates its own admin session when the customer actually clicks Save Build/Add to Cart.
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
      replyText = buildPreviewSynthesis(await getCustomerProfile(conversationId));
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

        // Fix (refactor: SSE ordering) — the reply text now carries a real synthesis (see
        // buildPreviewSynthesis) that's meant to actually be read, so it's sent BEFORE
        // preview_ready: the frontend navigates the browser away the instant preview_ready
        // arrives, and previously that happened before the chunk ever reached the widget at all.
        // Non-preview structured events (profile_progress, analysis_progress/candidate_products,
        // combination_recommendations, recommendation_refined) still go out ahead of the chunk so
        // the frontend can render any recommendation cards alongside the accompanying text.
        const previewEvents = [];
        for (const event of sseEvents || []) {
          if (event.type === "preview_ready") {
            previewEvents.push(event);
            continue;
          }
          send(event);
        }

        send({ type: "chunk", chunk: replyText });
        send({ type: "message_complete" });

        for (const event of previewEvents) {
          // Required diagnostic logging for the auto-preview flow — IDs/event metadata only,
          // never a full customer profile or private customer data. This is the exact SSE event
          // being sent down the wire to the widget for this turn.
          console.log("CHAT_PREVIEW_EVENT", JSON.stringify({
            conversationId,
            recommendationId: event.recommendationId,
            eventType: event.type,
            previewUrl: event.previewUrl,
          }));
          send(event);
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