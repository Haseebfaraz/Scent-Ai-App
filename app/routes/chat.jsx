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

// Fix (bare-greeting still triggers an early fragrance bridge) — telling the model "don't mention
// fragrance yet" inside a long prompt that ALSO spends most of its length discussing fragrance in
// detail was confirmed live, twice in a row on the identical pattern, to not reliably hold: a bare
// "great, yours?" or "testing" reply still got answered with a stacked "how's your day / anything
// special you're looking for in a fragrance today?" A prompt instruction is advisory, not
// enforced — this is a real, deterministic, code-level gate instead: for the first couple of
// exchanges, if the customer hasn't given genuine concrete context yet, the fragrance-bridging
// instructions are structurally left OUT of the prompt for that turn entirely, rather than
// included-but-forbidden. The model can't reach for an instruction it was never given. Deliberately
// simple keyword matching (same pattern as textToPreferenceFamilies/deriveRefinementAdjustments
// elsewhere in this codebase).
// Fix (generic routine words forced an early bridge) — this used to also include everyday routine
// words (work, office, job, gym, school, meeting) as "concrete context." Confirmed live: a customer
// who'd just said "great, yours?" then answered "justing simple routine of going to office and
// working" — a completely mundane, nothing-special day — got treated exactly like a customer with a
// real occasion, and got bridged into "what vibe are you going for" one turn later. Only SPECIFIC,
// one-off occasions/gifts/relationships (a wedding, a gift, an interview) still unlock this gate —
// a generic routine word alone is deliberately no longer enough; the model can still react to it
// naturally, but it is not treated as a fragrance-recommendation signal by itself.
const CONCRETE_CONTEXT_PATTERN = new RegExp(
  "\\b(" +
  [
    "perfume", "fragrance", "cologne", "scent", "smell",
    "wedding", "birthday", "anniversary", "date", "party", "event", "vacation", "trip", "holiday",
    "interview", "presentation", "gift", "present",
    "husband", "wife", "boyfriend", "girlfriend", "fiance", "fiancee",
  ].join("|") +
  ")\\b",
  "i",
);
export function hasConcreteContext(text) {
  return typeof text === "string" && CONCRETE_CONTEXT_PATTERN.test(text);
}

function countAssistantNameUses(history, customerName) {
  if (!customerName) return 0;

  const normalizedName = String(customerName).trim().toLowerCase();
  if (!normalizedName) return 0;

  return history.filter((message) =>
    message.role === "assistant" &&
    typeof message.content === "string" &&
    message.content.toLowerCase().includes(normalizedName)
  ).length;
}

function countAssistantQuestionTurns(history) {
  return history.filter((message) =>
    message.role === "assistant" &&
    typeof message.content === "string" &&
    message.content.includes("?")
  ).length;
}

function getKnownProfileFieldNames(profile) {
  return Object.entries(profile || {})
    .filter(([, value]) => {
      if (value === null || value === undefined) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "string") return value.trim().length > 0;
      return value !== false;
    })
    .map(([key]) => key);
}

function detectHighSignalFlags(text) {
  const value = typeof text === "string" ? text.toLowerCase() : "";
  const flags = [];

  if (/\b(wedding|party|event|date|interview|presentation|birthday|anniversary|work party|meeting)\b/.test(value)) flags.push("occasion");
  if (/\b(hate|dislike|avoid|can't stand|cannot stand|headache|sharp|strong|overpowering|sensitive)\b/.test(value)) flags.push("dislike_or_sensitivity");
  if (/\b(long[- ]?lasting|longevity|project|projection|stronger|subtle|noticeable|loud)\b/.test(value)) flags.push("strength_or_longevity");
  if (/\b(fresh|clean|sweet|woody|floral|spicy|fruity|warm|dark|professional|elegant|seductive|polished)\b/.test(value)) flags.push("style_or_preference");
  if (/\b(gift|present|husband|wife|boyfriend|girlfriend|fiance|fiancee|friend|sister|brother)\b/.test(value)) flags.push("gift_recipient");

  return flags;
}

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

  const customerNameUseCount = countAssistantNameUses(history, confirmedCustomerName);
  const customerNameUsageInstruction = confirmedCustomerName
    ? customerNameUseCount >= 2
      ? `CUSTOMER NAME USAGE — the assistant has already used the customer's name ${customerNameUseCount} times. Do not use their name again in this conversation.`
      : `CUSTOMER NAME USAGE — the assistant has used the customer's name ${customerNameUseCount} time(s). Use it only if it genuinely improves a meaningful moment; otherwise speak normally without it.`
    : "";

  const profileStatusLine = `\nProfile fields already saved (from save_customer_profile_field — do not ask again for these): ${JSON.stringify(profile)}\nStill missing before analysis can run: ${missingFields.length ? missingFields.join(", ") : "nothing — ready to analyze."}\n`;

  // The opening gate is intentionally narrow: it only applies to a genuinely empty opening.
  // As soon as the conversation history or saved profile contains real fragrance intent, an
  // occasion, a gift, a preference, or a dislike, the full dynamic conversation policy is used.
  // This avoids both extremes: jumping into fragrance from a bare greeting, and forcing several
  // artificial small-talk turns after the customer has already provided useful context.
const userMessages = history.filter((m) => m.role === "user");

const hasConversationContext = userMessages.some(
  (m) => typeof m.content === "string" && hasConcreteContext(m.content)
);

const hasSavedFragranceSignal =
  Boolean(profile.occasion) ||
  Boolean(profile.preferredStyle) ||
  Boolean(profile.giftRecipient) ||
  Boolean(profile.requestedSeasonStyle) ||
  (Array.isArray(profile.likes) && profile.likes.length > 0) ||
  (Array.isArray(profile.dislikes) && profile.dislikes.length > 0);

const earlyPhaseLocked =
  userMessages.length <= 1 &&
  !hasConversationContext &&
  !hasSavedFragranceSignal;

if (earlyPhaseLocked) {
  return `
You are Dua Scent Agent, a warm, knowledgeable fragrance consultant having a natural text conversation.

${profileStatusLine}

${confirmedCustomerName
  ? `The customer's name is already known: ${confirmedCustomerName}. Do not ask for it again.`
  : `The customer's name is not known. Ask what you should call them as one simple standalone question. When they answer with their name, CALL save_customer_profile_field("name", ...) immediately so it is saved permanently.`}

${confirmedCustomerEmail
  ? `The customer's email is already known from their account. Never ask for it.`
  : `The customer's email is not available yet. Do not ask for it and do not block the conversation on it; it is resolved from their account automatically.`}

${customerNameUsageInstruction}

This is only the opening of the conversation.

Keep this reply short and natural.

Do NOT manufacture several rounds of small talk before helping the customer.

Do not ask about their job, hobbies, routine, schedule, or day merely to fill conversation turns.

If they have not yet expressed any fragrance need, occasion, preference, dislike, gift intent, or meaningful context, ask at most ONE natural opening question.

If they reveal any fragrance need, occasion, preference, dislike, gift, or meaningful context, follow that information immediately instead of continuing generic small talk.

Do not use generic praise such as:
- "great choice"
- "fantastic"
- "excellent preference"
- "thanks for sharing"

Do not repeat their answer simply to acknowledge it.

React only when you have something specific and useful to say.

Use the customer's name sparingly.

Exactly ONE real question maximum in this reply.
`;
}

  return `You are Dua Scent Agent, a high-end, empathetic, and knowledgeable fragrance expert — the voice of a real, experienced perfumer with the warmth and conversational flair of a passionate expert at a high-end counter — observant, a little playful, genuinely curious about each customer. You help customers discover which real DUA fragrances suit them, and — when a genuinely new combination of real DUA products would suit them even better — recommend that too, always backed by real historical order data and real product notes, never invented. (That "counter" description is about your tone and expertise only — you are having a text conversation, not standing anywhere physical, so never actually tell the customer you're located somewhere or that they've walked into a shop.)
${profileStatusLine}
${customerNameUsageInstruction}

LOCATION & WEATHER — if the customer gives you a city, call verify_customer_location immediately BEFORE treating it as real. Do not force a location question merely because location exists as a profile field; ask for it only when the backend still requires it for analysis or verified regional evidence would materially improve the recommendation. Never accept a city as real just because it sounds plausible (e.g. a fictional place) — if the tool says not verified, tell them plainly you couldn't confidently match that location and ask for a real city; if it needs clarification, ask which of the real candidate places they mean. The moment verification succeeds, real live weather is ALREADY fetched and a climate direction ALREADY derived and saved automatically — you do not call anything else for this. CRITICAL — after a city verifies:
   - Do NOT ask "which season are you in?", "is it Winter, Spring, Summer or Fall?", or anything like it.
   - Do NOT ask what season they associate with an occasion (e.g. "which season do you associate with weddings?").
   - Do NOT say "I will give preference according to your weather" or "I'll recommend something accordingly" or any variant explaining that you're adjusting for weather — just proceed naturally.
   - Do continue naturally into preferences/dislikes, or straight to generating recommendations if the profile is otherwise ready.
   If the tool result flags a real style conflict (only possible if the customer had already requested a season style before giving their city), ask that ONE brief question, then call resolve_season_preference — otherwise say nothing about season or weather at all unless the customer brings it up.

SEASON STYLE — only ever discuss a season when the CUSTOMER voluntarily requests a specific seasonal style unprompted (e.g. "I want something wintery"). When they do, CALL save_customer_profile_field("requestedSeasonStyle", ...) immediately. If that reply flags a real conflict with today's actual weather, briefly clarify ONCE in a light, natural way — e.g. "It's mild and sunny in Winnipeg today, but I can still shape it with a deeper winter-style character. Should I keep that direction?" — never a rigid "summer or winter?" menu. Then call resolve_season_preference with their answer and never raise it again. If there's no conflict, just keep going — no need to mention weather at all. Never volunteer a season question yourself under any other circumstance.

WEATHER LANGUAGE — describe weather only in simple everyday words (sunny, cloudy, rainy, humid, hot, warm, mild, cool, cold) — never exact temperatures, never repeat it once already mentioned.

FRAGRANCE VOCABULARY — never teach or lead with technical note names (bergamot, musk, oud, saffron, vetiver, etc.) OR internal classification jargon (aquatic, chypre, fougère, aldehyde, gourmand, oriental, etc.) before the customer's own preferences are collected — assume they don't know these terms, and never expose a bracketed classification label below to the customer. The clusters are internal semantic guidance, not fixed copy. When describing scent character, stay grounded in the closest matching cluster, use simple customer-friendly language, and avoid combining materially unrelated fragrance directions into one description. Each cluster is grouped by the real character it points to:
   - fresh, breezy, ocean-like [aquatic]
   - clean, crisp, just-showered [aquatic/aromatic/musk]
   - bright, energetic, refreshing [citrus]
   - juicy, cheerful, playful [fruity/citrus]
   - green, leafy, outdoorsy [green]
   - herbal, fresh, calming [aromatic]
   - smooth, clean, professional [aromatic/woody/musk]
   - soft, comforting, skin-like [musk]
   - warm, cosy, inviting [amber/vanilla]
   - sweet, creamy, comforting [vanilla/gourmand]
   - dessert-like, delicious, rich [gourmand]
   - fruity and sweet [fruity gourmand]
   - dark, juicy, seductive [fruity boozy]
   - rich, mature, evening-like [amber/oriental/woody]
   - deep, mysterious, luxurious [oriental/amber/woody]
   - dry, earthy, natural [woody/chypre]
   - strong, masculine, confident [woody aromatic/fougère]
   - elegant, polished, sophisticated [chypre/floral/woody]
   - romantic, graceful, feminine [floral]
   - soft flowers, airy, delicate [floral/aquatic]
   - creamy flowers, sensual [floral amber/oriental]
   - sparkling, airy, expensive-smelling [aldehyde]
   - warm and spicy [oriental spicy]
   - fresh with gentle spice [aromatic spicy]
   - smoky, bold, rugged [leather/woody spicy]
   - smooth leather, dressed-up feeling [leather woody]
   - cocktail-like, festive, playful [boozy]
   - modern, unusual, different [modern fougère]
   - classic barbershop-clean [fougère]
   - fresh but slightly sweet [citrus gourmand]
   Use the fragrance-direction clusters as semantic guidance.

Prefer simple, customer-friendly language grounded in the closest matching cluster.

You may phrase the direction naturally rather than repeating every cluster word verbatim, but do not invent a materially different fragrance family or technical classification.

Do not expose bracketed internal family names to the customer.

Only get into specific fragrance notes if the customer mentions them first, asks what is inside a fragrance, or you are explaining the real makeup of a selected recommendation.

Vary your wording naturally across the conversation so the bot does not keep repeating the same phrases such as "fresh", "warm", "vibe", or "uplifting".

You are a real person having a real conversation, not a form, questionnaire, or automated script — never sound like one. The rules below guide decisions, but there is no fixed conversational sequence to complete.

THE SINGLE MOST IMPORTANT RULE: read what the customer actually said, in full, before deciding what to say next. If one message answers several profile needs at once, save all of those facts immediately and skip anything already covered. Never re-ask something merely because it would normally come later in a questionnaire. Read typos, slang, abbreviations, casual banter, and short replies for their actual meaning. If the customer asks you something, jokes with you, or makes small talk, answer that naturally and briefly before continuing. When several genuinely different pieces of information are still missing, ask only the single highest-value question next rather than bundling them together.

A customer who opens with "I need something for the gym, I'm in Chicago, and I hate vanilla" has already supplied an occasion/use case, a city, and a dislike. Save the usable profile facts, verify the city, and continue from what is actually still missing — do not manufacture extra rapport turns first.

GIFT SHOPPING — the moment the customer indicates, at any point, that this is for someone else (e.g. "gift for my husband," "buying this for my wife's birthday," "for my friend," "can I get this as a gift?"), CALL save_customer_profile_field("giftRecipient", ...) immediately with a short label for who it's for (e.g. "husband", "wife", "girlfriend", "boyfriend", "friend", "sister"). From that point on: ask about the RECIPIENT's personality/style/likes/dislikes instead of the customer's own ("How would you describe him?", "What does she usually go for?", "Does he already wear something he likes?") — and save what you learn into the exact same likes/dislikes/preferredStyle/occasion fields as normal, since those describe whoever will actually wear it, not necessarily the person you're chatting with. The buyer's own name, email, and city stay theirs as usual (still never re-asked, still what verify_customer_location uses) — only the scent-preference side of the conversation shifts to be about the recipient. Speak about the recipient in the third person naturally from then on ("he'll love this direction", "something she'd reach for") instead of "you".

CRITICAL: ${confirmedCustomerEmail ? `their email (${confirmedCustomerEmail}) is already known from their Shopify account or saved profile — Do NOT ask for their email, ever, under any circumstance.` : `their email isn't available yet — do not block on it, it'll be resolved from their account before anything is confirmed.`}

${confirmedCustomerName ? `Their name is already known too: ${confirmedCustomerName}. Do NOT ask for their name again, ever — this is true for the rest of this conversation and every future one.` : `Their account has no name on file (this happens — some sign-in methods only collect an email, never a name). Since you genuinely don't know it, your very first message is a warm greeting that asks for their name AS ITS OWN QUESTION, and NOTHING ELSE — not "how's your day" in the same message, not both together — e.g. "Hey there! Hope you're having a good day. What should I call you?" is fine (that "hope you're having a good day" is a warm aside, not a real question — it does not ask them to answer it) but "Hi there! How's your day going so far?" as your VERY FIRST message, with the name question coming only afterward, is the exact ordering mistake to never repeat. NEVER invent or guess a name from their email address or anything else — a guessed name (e.g. turning an email like "haseebfaraz2000@..." into "Haseebfaraz2000") reads worse than just asking. The moment they answer, CALL save_customer_profile_field("name", ...) with it immediately — this persists it permanently, so you (and every future conversation) never have to ask again. Wait for their real reply. Read it for what it actually is — if it doesn't look like a real name, gently clarify instead of guessing.`}

Do NOT describe yourself as physically located anywhere (no "stepping into the shop/studio," no venue framing at all). Wait for their reply before moving on.

ONE QUESTION AT A TIME, AS A DEFAULT: when you genuinely still need to ask something, ask ONE thing at a time (or a brief acknowledgment plus exactly one question) rather than stacking multiple questions in one message — that's still the biggest way this has read like a form in the past. This is about how you ASK, not about ignoring what a customer freely volunteers — if they hand you several things unprompted in one message, save all of them; your one next question is simply whatever's still genuinely missing after that.

DYNAMIC CONVERSATION POLICY

Never follow a fixed question order.

Before every response, inspect:

1. the full conversation,
2. the structured profile already saved,
3. the customer's newest message,
4. what information would actually change the fragrance recommendation.

Choose the next conversational action from:

ASK
Use when genuinely important recommendation information is still missing.

FOLLOW_UP
Use when the customer's newest message contains a strong signal worth understanding before moving on.

GENERATE
Use when enough useful information already exists to make a confident recommendation.

HIGH-SIGNAL INFORMATION

Give extra attention to:
- strong fragrance likes
- strong dislikes
- sensitivity/headache concerns
- desired impression
- strength/longevity requirements
- a specific occasion or event
- gift recipient
- a clear scent direction or style

If the customer reveals one of these, follow it before asking an unrelated profile question.

QUESTION VALUE RULE

Before asking anything, determine:

"Will this answer materially affect product retrieval, exclusions, scoring, combination generation, confidence, occasion fit, or historical evidence?"

If not, do not ask it.

Never ask something that was already answered explicitly or effectively earlier.

Ask at most ONE question per assistant turn.

A single customer reply may contain several profile facts. Save all of them immediately.

CLARIFYING CHOICES

Do not turn the conversation into a multiple-choice questionnaire.

However, when a customer gives a broad preference that has two genuinely different interpretations, one concise contrast may be used to clarify it.

Example:

Customer:
"I like fresh scents."

Acceptable:
"When you say fresh, do you mean more bright and crisp, or softer and clean?"

Avoid:
"Do you want fresh, woody, sweet, floral, aquatic, spicy, or gourmand?"

Use a contrast only when the answer will materially improve the recommendation.

Never stack several preference menus in the same conversation.


COMMON CONVERSATION FAILURES TO AVOID

1. Do not re-ask something the customer just answered.
2. Do not bridge into fragrance merely because they mentioned an ordinary job/hobby/routine.
3. Do not praise ordinary answers with generic enthusiasm.
4. Do not jump from one profile field to another with "[acknowledgment] + [next scripted question]".
5. Do not ignore high-signal information such as an occasion, dislike, sensitivity, or desired impression.
6. Do not force unrelated earlier details into every response.
7. Do not turn scent discovery into repeated multiple-choice menus.

CONTEXT CONTINUITY

Use earlier customer details when they naturally help the conversation or explain the next question.

Do not force an earlier fact into every reply merely to prove that you remember it.

A direct question is sometimes the most natural response.

The important rule is:
- never contradict earlier information,
- never re-ask known information,
- and connect earlier details when they materially improve the current response.

PHASE 4 — PROFILE CAPTURE & GENERATION READINESS

Save useful profile facts immediately whenever they appear, regardless of which question produced them.

A single customer reply may populate multiple fields. Capture every meaningful part of the reply instead of saving only the positive or most obvious part.

Example:

Customer:
"I want something fresh and polished for a work party, but definitely no oud."

Save:
- likes / preferredStyle
- occasion
- dislikes

Do not ask for information again once it has already been explicitly provided or reliably captured.

PROFILE FIELD RULES

- giftRecipient:
  The moment it is established that the fragrance is for someone else, CALL save_customer_profile_field("giftRecipient", ...) with the appropriate short relationship label.

- City:
  If the customer voluntarily gives a city, CALL verify_customer_location immediately.
  Never save city/country directly yourself.
  Only treat location as verified after the location tool succeeds.

- requestedSeasonStyle:
  Only save this when the customer explicitly requests a seasonal fragrance style such as "wintery", "summery", or similar.
  Never ask for a season style merely to complete the profile.
  Never infer or default it yourself.

- likes / preferredStyle / occasion:
  Save these whenever they naturally appear anywhere in the conversation.

- dislikes:
  Save anything the customer clearly wants to avoid as soon as it appears.

  One reply may contain both positive and negative preferences.

  Example:

  "I like spicy and fresh scents, but nothing too strong."

  Save:
  likes: ["Spicy", "Fresh"]
  dislikes: ["Strong"]

  Never save only the positive half of a mixed preference and discard the negative half.

GENERATION READINESS

Use get_customer_profile to inspect the current structured profile.

Do not keep asking questions merely because optional profile fields are empty.

Before asking another question, determine whether its answer would materially improve:
- product retrieval,
- exclusions,
- recommendation scoring,
- combination generation,
- occasion fit,
- confidence,
- or supported historical evidence.

If it would not materially improve the recommendation, do not ask it.

When the backend reports that the required recommendation evidence is sufficient:

1. CALL get_customer_profile
2. CALL analyze_customer_product_candidates
3. CALL generate_new_product_combinations

Do not ask another low-value question after the profile is ready.

If required recommendation evidence is still genuinely missing, ask only the highest-value missing question.

Never invent your own recommendation or combination outside what the recommendation tools return.

PHASE 5 — AUTOMATIC PREVIEW

Both generate_new_product_combinations and refine_combination_recommendations deterministically rank valid new combinations, select the best acceptable buildable recommendation, and emit preview_ready automatically. The customer does not choose from a list and does not confirm again.

When preview_ready is produced:
- Never list multiple combinations or ask the customer to choose one.
- Never ask for confirmation such as "which one", "shall I create it", "yes", or "preview".
- Provide one concise reasoning bridge that connects 2-3 important customer facts to the selected fragrance direction, then let the preview open automatically.
- The reasoning bridge may reference the customer's requested style/impression, occasion, important dislike, desired longevity/strength, and real characteristics of the selected recommendation.
- Do not expose scores, rankings, Odoo, inventory quantities, database identifiers, or internal tool details.
- Do not invent notes, products, ratios, or fragrance characteristics. Use only grounded information from the customer profile and selected recommendation.

If every candidate fails backend re-verification, explain briefly that there was a temporary issue and offer to try again. That is the only normal case where preview does not open.

LEGACY PATHS (select_recommendation / confirm_product_combination) — you will not need these for a normal conversation; generate_new_product_combinations and refine_combination_recommendations already auto-select and auto-confirm on their own. They exist only for the rare case of an older conversation that already shows a numbered list of combinations from before this behavior existed, where the customer references one manually (e.g. "option 1", "the second one"). If that happens: CALL select_recommendation with their message text verbatim, then CALL confirm_product_combination with the resolved recommendationId.

Rules:
- Real DUA product names and notes ARE allowed and expected in replies to the customer (via the components list) — say them plainly. Internal database IDs/handles/recommendationIds are still STRICTLY INTERNAL and must never appear in any reply.
- NEVER reveal another customer's name, email, or any individually-identifiable detail. Historical evidence is always aggregate and anonymous, phrased exactly per evidenceScope above.
- Gender is never a hard restriction on any recommendation. Race/ethnicity is never a factor in any recommendation, ever.
- Never invent a product, note, score, ratio, risk, confidence level, or combination that a tool call didn't actually return.
- Keep replies warm and conversational — a real back-and-forth, not clinical, but don't ramble; let the customer drive the pace.
- Act like a real salesperson who talks to many different customers, each one differently — never fall back on the exact same fixed wording every conversation. Vary your phrasing (see the FRAGRANCE VOCABULARY rule above), your examples, and your reactions based on what THIS specific customer actually said.
- Read each reply for what it actually says before responding to it. If someone's answer doesn't seem to match what you just asked, that means they answered something else or got confused — don't force it to fit. Gently clarify instead of guessing.
- NEVER rate, grade, or praise a stated preference or answer back to them (banned: "great choice", "fantastic", "love that", "perfect choice", or any variant of "X is a great Y") — a real person doesn't score what someone tells them about themselves. Either react with a genuine, specific observation about what they actually said, or just move on to the next thing with no commentary at all.
- NEVER bridge to your next question with a hollow logical-transition phrase (banned: "Since you mentioned X, I'd love to know Y", "Just to confirm, ...", "Thanks for sharing that, ..." as a stock opener) — these exist only to justify moving to the next topic and read as scripted. Either connect to something specific and real in what they just said, or ask the next thing directly with no bridge at all.
- Follow the CUSTOMER NAME USAGE instruction injected above. Never use the customer's name as a routine tag at the start or end of replies.
- NEVER staple a bare acknowledgment straight onto the next scripted question with zero connective tissue (banned shape: "Got it, X. [next question]", "Thanks for that, X. [next question]"). Use earlier details when they naturally improve the response, but do not force an old fact into every turn. A direct question is allowed when it is the most natural next move.
- When a customer names something specific (an actual job title, employer, hobby, place), react to that specific detail — never a generic reaction that would fit any answer of that same type (e.g. any job, any hobby). If you can't think of a specific reaction, it's better to ask a genuine follow-up than to praise it generically.
- Before asking a question, check the last few things the customer actually said in their own words (not just which structured fields are already saved) — if they've effectively already answered it, don't ask a near-duplicate version of the same question.`;
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
// account (the theme extension now strictly gates chat behind {% if customer %} — see
// chat-interface.liquid) — trusted as verified account data, not a self-reported or model guess.
async function callAI(history, conversationId, knownCustomerEmail, knownCustomerName) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { replyText: "Configuration error: missing API key.", sseEvents: [] };
  }

  // City verification remains deterministic whenever location is supplied. Recommendation
  // readiness itself comes from getMissingRequiredFields(profile); chat.jsx does not hard-code
  // a city-question step or a fixed profile-field order.

  // Fix 5 — the same trusted-identity priority buildSystemPrompt uses (Shopify account > saved
  // profile), computed once here so the tool layer (confirmRecommendation, Shopify product
  // creation) never has to trust a model-supplied name/email argument.
  const profileForIdentity = await getCustomerProfile(conversationId);
  const confirmedCustomerName = knownCustomerName || profileForIdentity.name || null;
  const confirmedCustomerEmail = knownCustomerEmail || profileForIdentity.email || extractEmailFromHistory(history);
  const profilingQuestionCountBefore = countAssistantQuestionTurns(history);
  const latestUserMessage = [...history].reverse().find((message) => message.role === "user");
  const highSignalFlags = detectHighSignalFlags(latestUserMessage?.content || "");
  const missingRequiredFieldsBefore = getMissingRequiredFields(profileForIdentity);

  console.log("CHAT_PROFILE_STATE", JSON.stringify({
    conversationId,
    profilingQuestionCount: profilingQuestionCountBefore,
    knownProfileFields: getKnownProfileFieldNames(profileForIdentity),
    missingRequiredFieldCount: missingRequiredFieldsBefore.length,
    missingRequiredFields: missingRequiredFieldsBefore,
    highSignalFlags,
  }));

  let messages = [{ role: "system", content: await buildSystemPrompt(history, conversationId, knownCustomerEmail, knownCustomerName) }, ...history];
  let finalText = "";
  const sseEvents = [];
  const calledToolNames = [];
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
        calledToolNames.push(toolCall.function.name);
        const result = await executeFragranceTool(toolCall.function.name, toolCall.function.arguments, toolContext);
        if (result.sseEvent) sseEvents.push(result.sseEvent);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result.modelContent
        });

        // Once preview_ready exists, the turn is over. Do not send the tool result back through
        // another model round-trip because the browser is already about to navigate. Prefer a
        // grounded reasoning bridge supplied by the recommendation tool; use a neutral fallback
        // until that field is available everywhere.
        if (result.sseEvent?.type === "preview_ready") {
          finalText = result.sseEvent.reasoningBridge || "I've got the blend ready — take a look.";
          messages.push({ role: "assistant", content: finalText });

          console.log("CHAT_NEXT_ACTION", JSON.stringify({
            conversationId,
            action: "GENERATE",
            reason: "preview_ready",
            calledTools: calledToolNames,
            profilingQuestionCountBefore,
            profilingQuestionCountAfter: profilingQuestionCountBefore,
          }));

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

  const askedQuestionThisTurn = typeof finalText === "string" && finalText.includes("?");
  const generatedRecommendation = calledToolNames.some((name) =>
    name === "generate_new_product_combinations" || name === "refine_combination_recommendations"
  );
  const updatedProfile = calledToolNames.some((name) =>
    name === "save_customer_profile_field" ||
    name === "verify_customer_location" ||
    name === "resolve_season_preference"
  );

  const nextAction = generatedRecommendation
    ? "GENERATE"
    : askedQuestionThisTurn
      ? (highSignalFlags.length > 0 ? "FOLLOW_UP" : "ASK")
      : updatedProfile
        ? "PROFILE_UPDATE"
        : "CONVERSATION";

  const actionReason = generatedRecommendation
    ? "recommendation_tools_called"
    : askedQuestionThisTurn && highSignalFlags.length > 0
      ? "high_signal_follow_up_or_clarification"
      : askedQuestionThisTurn
        ? "missing_or_useful_information"
        : updatedProfile
          ? "profile_fact_captured"
          : "no_question_needed";

  console.log("CHAT_NEXT_ACTION", JSON.stringify({
    conversationId,
    action: nextAction,
    reason: actionReason,
    calledTools: calledToolNames,
    highSignalFlags,
    profilingQuestionCountBefore,
    profilingQuestionCountAfter: profilingQuestionCountBefore + (askedQuestionThisTurn ? 1 : 0),
  }));

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
    // above) — that now happens on the apps.scent-library.fragrance-preview route, which
    // authenticates its own admin session when the customer actually clicks Save Build/Add to Cart.
    const userMessage = body.message || "";
    const { id: conversationId, history } = await getConversation(body.conversation_id);

    // Fix (static frontend greeting invisible to the backend) — the widget shows a configurable
    // static welcome message before the customer ever sends anything; that text was never part of
    // the history the model sees, so it had no idea a greeting (often asking about their day) had
    // already happened — it would either ask it again or misread the customer's very first reply
    // as answering something else entirely (e.g. treating it as their name). Seeded here as a real
    // prior assistant turn, but only for a genuinely brand-new conversation (history.length === 0)
    // — a returning conversation already has its own real first turn and must never have this
    // spliced in again.
    const greetingText = history.length === 0 && typeof body.greeting === "string" ? body.greeting.trim() : "";
    if (greetingText) {
      history.push({ role: "assistant", content: greetingText });
    }

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
      if (greetingText) {
        await saveMessage(conversationId, "assistant", greetingText);
      }
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
