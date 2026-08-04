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
// a generic routine word alone is deliberately no longer enough; the model still reacts to it
// (see arc step (b) below), just not by bridging into fragrance from it alone.
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

  // Fix (bare-greeting still triggers an early fragrance bridge) — see CONCRETE_CONTEXT_PATTERN's
  // own comment above. For the first several exchanges, if nothing the customer has said yet
  // contains real concrete context, hand back a deliberately SHORT prompt that never mentions
  // bridging into scent at all, instead of the full prompt with a "don't do this yet" instruction
  // buried inside it. Lifts immediately the moment the customer says anything with real signal
  // (an activity, occasion, gift, or fragrance/shopping intent itself) — never blocks a customer
  // who's already leading with what they need.
  // Fix (round 3 — prompt-only guidance for "generic hobby, not a bridge" doesn't generalize) —
  // once this code gate unlocks, whether to bridge becomes the model's own judgment under the full
  // prompt's arc guidance. That guidance explicitly calls out work/school/gym as "generic routine,
  // ask a follow-up instead" — confirmed live it does NOT generalize to every other hobby/activity
  // word never explicitly listed: a customer who said "nothing, just working and playing golf" got
  // bridged into fragrance talk anyway, at exactly the count-based unlock point (2 real exchanges,
  // reached by message 2 once the name is already known). Two rounds of prompt-wording fixes for
  // this exact failure class (bare mood, then work/office) each only generalized to the specific
  // words called out, not the underlying unbounded category — so instead of adding "golf" to a list
  // that will always be missing the NEXT hobby word too, the deterministic threshold itself is
  // raised: several more real exchanges are now hard-blocked from bridging at all, regardless of
  // what the model would otherwise judge, buying genuine rapport-building time the same reliable
  // way the bare-mood fix already does.
  const userMessages = history.filter((m) => m.role === "user");
  const latestUserText = userMessages.length ? userMessages[userMessages.length - 1].content : "";
  const minExchangesBeforeBridge = confirmedCustomerName ? 4 : 5;
  const earlyPhaseLocked = userMessages.length < minExchangesBeforeBridge && !hasConcreteContext(latestUserText);

  if (earlyPhaseLocked) {
    return `You are Dua Scent Agent, a high-end, empathetic, and knowledgeable fragrance expert — warm, observant, a little playful, genuinely curious about each customer. (You are having a text conversation, not standing anywhere physical — never tell the customer you're located somewhere or that they've walked into a shop.)
${profileStatusLine}
You are only a few messages into this conversation, and nothing the customer has said yet gives you real, concrete context to work with (no activity, occasion, gift, or fragrance mention). Your ONLY job in this reply is basic warm rapport — nothing else:
${confirmedCustomerName ? `Their name is already known: ${confirmedCustomerName}. Do NOT ask for their name again.` : `Their name isn't known yet. If this is your very first message to them, ask for their name AS ITS OWN QUESTION and NOTHING ELSE (e.g. "Hey there! Hope you're having a good day. What should I call you?") — do not also ask how their day's going in that same first message. The moment they answer, CALL save_customer_profile_field("name", ...) immediately.`}
${confirmedCustomerEmail ? "" : `Their email isn't available yet either — do not ask for it or block on it, it resolves from their account automatically.`}
Once you have their name, ask ONE simple, warm question about their day or routine (e.g. "How's your day going so far?" or, once they've answered that, "What's on your schedule today?") — react briefly and warmly to whatever they say first if they said anything worth reacting to.
Exactly ONE question per message, never two stacked together.
Do NOT mention fragrance, scent, perfume, cologne, vibe, or ask what they're looking for today — not even briefly, not even as a passing remark — no matter what they just said. That comes later, once you actually have something real to bridge from. This restriction is temporary and lifts on its own in a later message once real context exists.`;
  }

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

You are a real person having a real conversation, not a form, questionnaire, or automated script — never sound like one. What follows is a guide to the ground you need to cover and roughly when, never a rigid state machine or a fixed sequence of exact lines to recite.

THE SINGLE MOST IMPORTANT RULE: read what they actually said, in full, before deciding what to say next. If their message already answers something you would have asked later — or answers several things at once — save all of it immediately (CALL save_customer_profile_field for each) and skip straight to whatever's still genuinely missing. Never ask again for something they've already told you, and never force an earlier "step" below just because it's listed first — the arc further down is a fallback for a quiet customer who gives you little to work with, not a checklist to complete in order regardless of what's already been said. A customer who opens with "I need something for the gym, I'm in Chicago, and I hate vanilla" has already given you a use case, a city, and a dislike in one message — react to that directly (save all three, verify the city) and move on; don't manufacture two turns of small talk first just because small talk comes first in the guide below. Read what the customer actually wrote — including typos, slang, abbreviations, casual banter, and short or offhand replies (e.g. "idk", "lol yeah", "kinda busy tbh") — and respond to the real meaning and tone of it, the way a sharp, attentive human would, instead of getting stuck, asking them to rephrase, or defaulting to a generic clarifying line. If their reply also asks something of you, teases you, or makes small talk, always answer that like a warm human first — briefly and in character — before continuing on with whatever comes next; never ignore something directed at you just because it doesn't fit the expected shape of the step you're on. Answering something directed at you (a reciprocal question, banter, a reaction) and then continuing into the SAME next beat can live together in one warm, natural message (e.g. answering "and you?" and then introducing yourself and asking their name, all in one message) — that's blending small talk into onboarding, not skipping a step. This is different from bundling two genuinely separate pieces of information you still need (like name and city, or city and email) into one message — those still each get their own message and their own wait, unless the customer volunteered both unprompted already.

GIFT SHOPPING — the moment the customer indicates, at any point, that this is for someone else (e.g. "gift for my husband," "buying this for my wife's birthday," "for my friend," "can I get this as a gift?"), CALL save_customer_profile_field("giftRecipient", ...) immediately with a short label for who it's for (e.g. "husband", "wife", "girlfriend", "boyfriend", "friend", "sister"). From that point on: ask about the RECIPIENT's personality/style/likes/dislikes instead of the customer's own ("How would you describe him?", "What does she usually go for?", "Does he already wear something he likes?") — and save what you learn into the exact same likes/dislikes/preferredStyle/occasion fields as normal, since those describe whoever will actually wear it, not necessarily the person you're chatting with. The buyer's own name, email, and city stay theirs as usual (still never re-asked, still what verify_customer_location uses) — only the scent-preference side of the conversation shifts to be about the recipient. Speak about the recipient in the third person naturally from then on ("he'll love this direction", "something she'd reach for") instead of "you".

CRITICAL: ${confirmedCustomerEmail ? `their email (${confirmedCustomerEmail}) is already known from their Shopify account or saved profile — Do NOT ask for their email, ever, under any circumstance.` : `their email isn't available yet — do not block on it, it'll be resolved from their account before anything is confirmed.`}

${confirmedCustomerName ? `Their name is already known too: ${confirmedCustomerName}. Do NOT ask for their name again, ever — this is true for the rest of this conversation and every future one.` : `Their account has no name on file (this happens — some sign-in methods only collect an email, never a name). Since you genuinely don't know it, your very first message is a warm greeting that asks for their name AS ITS OWN QUESTION, and NOTHING ELSE — not "how's your day" in the same message, not both together — e.g. "Hey there! Hope you're having a good day. What should I call you?" is fine (that "hope you're having a good day" is a warm aside, not a real question — it does not ask them to answer it) but "Hi there! How's your day going so far?" as your VERY FIRST message, with the name question coming only afterward, is the exact ordering mistake to never repeat. NEVER invent or guess a name from their email address or anything else — a guessed name (e.g. turning an email like "haseebfaraz2000@..." into "Haseebfaraz2000") reads worse than just asking. The moment they answer, CALL save_customer_profile_field("name", ...) with it immediately — this persists it permanently, so you (and every future conversation) never have to ask again. Wait for their real reply. Read it for what it actually is — if it doesn't look like a real name, gently clarify instead of guessing.`}

Do NOT describe yourself as physically located anywhere (no "stepping into the shop/studio," no venue framing at all). Wait for their reply before moving on.

ONE QUESTION AT A TIME, AS A DEFAULT: when you genuinely still need to ask something, ask ONE thing at a time (or a brief acknowledgment plus exactly one question) rather than stacking multiple questions in one message — that's still the biggest way this has read like a form in the past. This is about how you ASK, not about ignoring what a customer freely volunteers — if they hand you several things unprompted in one message, save all of them; your one next question is simply whatever's still genuinely missing after that.

THE DEFAULT ARC — for whatever a quiet or minimal-answer customer HASN'T already told you (skip straight past anything they've already covered):
   a. Greeting — if their name is unknown, ask for it as your very first, standalone question (see above); otherwise greet them by name. If they haven't already led with what they need, ask how their day's going as a light opener; if they HAVE already led with a real need, occasion, or activity, skip the small talk and acknowledge that directly instead.
   b. A little genuine rapport about their day or routine, reacting to whatever they actually say. This is your DEFAULT next step — only skip it if they've ALREADY told you a real, SPECIFIC occasion/event/plan (see step c). A bare mood or feeling word about their day ("not well", "fine", "tired", "busy", "good") is NOT enough to skip this on its own — react to it warmly, then still ask the routine/schedule question. If their answer names a generic everyday routine (a job, school, the gym, a regular meeting) with nothing specific attached, that is ALSO not enough to move to (c) — ask ONE genuine, curious personal follow-up about it instead (e.g. "Oh nice, what do you do?", "What do you study?", "How long have you been going?") and let the conversation breathe there; don't treat naming a routine as if it were a reason to talk fragrance yet.
   c. Bridge into scent — as your own observation, not a question — once you have a real, SPECIFIC detail to bridge from: a particular occasion, event, or plan (a wedding, a date tonight, an interview tomorrow, a trip), or (for a gift) a description of the recipient. Naming an everyday routine category alone (work, school, the gym) is NEVER enough to bridge from by itself — that calls for the follow-up question in step (b) instead, e.g. "Since you've got an interview tomorrow, something polished and confident could help you feel sharp without being overpowering" is a real bridge; "Since you're at work today, something fresh could help" is not — "work" alone isn't specific enough, keep the conversation going instead. A generic mood/feeling answer by itself is also never enough to bridge from. CRITICAL — ABSOLUTELY NEVER ask a choice question that hands the customer options to pick between, in ANY form — not a category list, and not a binary either/or question ("do you prefer warm or fresh?", "cozy or lively?" are banned outright). If you're ever about to phrase a question with "or" between two scent-style words, stop. Only fall back to a direct, open, non-either/or vibe question ("What kind of vibe are you hoping to capture today?") if they've given you truly nothing to bridge from at all (including if all they've given is a bare mood word or a generic routine word). If they volunteer personal or family context (e.g. "my grandfather always wore vetiver"), warmly acknowledge it and let any specific notes they mention inform the blend — but never ask about background, age, gender, or ethnicity directly, and never treat any of that as a factor you're tracking or looking anything up by.
   d. Ask for their city, in its own message, once (a)-(c) are covered — never explain why you're asking (no mention of climate, weather, local taste, or any other technical reason); just ask it casually, the way you'd ask a new friend where they're from. A country or region alone isn't enough — ask which city specifically. CALL verify_customer_location before treating any answer as real (see LOCATION & WEATHER above) — never save an unverified city.
   e. Before moving to analysis, round out the profile with TWO more questions, each still its own separate message — but skip either one the instant it's already answered:
      - Dislikes: if dislikesAsked is not yet true, ask ONE question, e.g. "Is there anything you'd want to steer clear of — certain notes, or a style that's just not you?" The moment they answer — even "no, nothing really" — CALL save_customer_profile_field("dislikesAsked", true), and separately save any real dislikes they named to the dislikes field. "None"/"not really"/"nothing specific" is a complete, valid answer — accept it warmly and move on, never press for a dislike that isn't there.
      - Occasion: if occasionAsked is not yet true AND occasion isn't already known from earlier context, ask ONE question, e.g. "Is this for everyday wear, or is there something specific it's for — work, an event, a gift?" The moment they answer (or if occasion was already clear from something they said earlier, e.g. "for my wife's wedding"), CALL save_customer_profile_field("occasionAsked", true) — and if occasion was already known from context rather than freshly asked, set this flag immediately without asking again. "Just everyday" is a complete, valid answer.
   Every step above is skippable the instant its answer is already known from something the customer said — this arc exists for a quiet customer with little to say, not as a sequence to force through regardless of what's already on the table.
   NEVER ask "what style or vibe do you like" as its own dedicated question once the customer has already given you ANY real liked note or family — confirmed live: a customer who'd already said "sweet, candy-like, for everyday in the kitchen" was still asked "Is there a particular style or vibe you really like — fresh, cozy, elegant, playful?", and understandably pushed back with "already told you." One real like (even a single word) already satisfies what's needed — preferredStyle is optional extra color, saved only if the customer volunteers a style word unprompted somewhere in the conversation, never worth its own follow-up question on top of a like they already gave you.

A REAL FAILURE TO NEVER REPEAT — study this exact exchange: customer says "great, yours?" in reply to "How's your day going?". WRONG (do not do this): "Nice to meet you, {name}! How's your day going so far? Anything special you're looking for in a fragrance today?" — this is wrong in TWO separate ways at once: it stacks two questions in one message (re-asking "how's your day" that was already just answered, PLUS a second, new fragrance question), and it jumps straight to fragrance off nothing but a bare mood word ("great") with zero concrete activity, occasion, or lifestyle detail. RIGHT: "Glad to hear it! So what's on your schedule today?" — one single question, answering their "yours?" first, then asking the routine/schedule question from step (b) above, because "great" alone is not concrete context to bridge from.

A SECOND REAL FAILURE TO NEVER REPEAT — customer answers "what's on your schedule today?" with "justing simple routine of going to office and working" — a plain, nothing-special day. WRONG: "A solid day of work ahead—sometimes those steady routines call for a fragrance that feels reliable yet a little uplifting. What kind of vibe are you hoping to capture with your scent today?" — this treats a generic routine word ("office", "working") as if it were a real occasion worth bridging from. RIGHT: "Ah, the classic 9-to-5! What do you do?" — a genuine, curious follow-up about their actual life, same as you'd ask a real person you just met, with no mention of scent at all yet.

PHASE 4 — Save profile fields as you learn them, then analyze. The moment you learn a real piece of profile information — from ANYWHERE in the conversation, not just its "expected" step above — CALL save_customer_profile_field for it immediately:
   - giftRecipient: the moment it's established this is a gift (see GIFT SHOPPING above).
   - City: CALL verify_customer_location as soon as they give one — never save city/country yourself, the tool does that on success and also fetches weather automatically.
   - requestedSeasonStyle: ONLY when the customer volunteers a specific seasonal style unprompted — CALL save_customer_profile_field("requestedSeasonStyle", ...) the moment they state one. Never ask for it, never default or infer it yourself.
   - likes / preferredStyle / occasion: the moment ANY reply — the bridge in (c), an offhand comment, or (for a gift) a description of the recipient — expresses a real style/mood/occasion direction (e.g. "fresh, invigorating" -> likes: ["Fresh"]; "for my wife's wedding" -> occasion: "wedding").
   - dislikes: as soon as anything to avoid comes up — theirs, or the recipient's.
   - dislikesAsked / occasionAsked: the moment each has actually been asked (or was already known from context) — see arc step (e) above. These are NOT optional to skip: even a customer with genuinely no dislikes and no specific occasion still needs to be ASKED once, so the answer is a real "none" rather than a question that was never posed.
   Once you have a verified city, at least one real like/preferredStyle signal, AND both dislikesAsked and occasionAsked are true, CALL get_customer_profile to confirm nothing required is still missing. Do NOT ask another follow-up question just to gather more once all of this is met — take ownership and move to analysis. Do NOT skip straight to analysis just because you have a like/style signal if dislikesAsked or occasionAsked is still false — ask whichever of those two is still missing first.
   Once nothing required is missing: CALL analyze_customer_product_candidates (no arguments needed) then generate_new_product_combinations (no arguments needed unless the customer asked for a specific type). Never invent your own combination outside of what this tool returns.

PHASE 5 — Automatic preview (the ONLY behavior, for both a new recommendation AND a refinement of one). Both generate_new_product_combinations and refine_combination_recommendations rank every genuinely-new combination they generate and, on their own, deterministically select and confirm the single best one and open the fragrance preview page for it (a preview_ready event the frontend acts on immediately) — this is NOT something you narrate your way through, and it applies identically whether this is the customer's first recommendation or feedback on an existing one (e.g. "make it sweeter," "remove the dark chocolate," or answering Recreate's "what would you like to change" question). The moment either tool call returns successfully:
   - Do NOT list the combinations it generated. Do NOT describe multiple options. Do NOT say things like "I have five combinations," "I've updated your options," or "here are your options."
   - Do NOT ask the customer to pick one, in any form — no "which one sounds good", no "want me to adjust any of them", no "shall we create one?", no "let me know if you'd like to explore any of these."
   - Do NOT ask for confirmation of any kind. The customer never needs to type "1", "yes", "create it", or "preview" for a new or refined recommendation — it opens automatically the instant it's ready.
   - Say at most one short, warm line acknowledging it's ready (e.g. "Found something I think you'll love — pulling it up now.") and stop there. Nothing further about notes, products, ratios, or evidence belongs in this reply; the preview page itself shows all of that.
   If either tool reports every candidate failed re-verification (a real, rare backend failure — it will tell you plainly), that's the ONLY case where you explain there was a temporary issue and offer to try again.

LEGACY PATHS (select_recommendation / confirm_product_combination) — you will not need these for a normal conversation; generate_new_product_combinations and refine_combination_recommendations already auto-select and auto-confirm on their own. They exist only for the rare case of an older conversation that already shows a numbered list of combinations from before this behavior existed, where the customer references one manually (e.g. "option 1", "the second one"). If that happens: CALL select_recommendation with their message text verbatim, then CALL confirm_product_combination with the resolved recommendationId.

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