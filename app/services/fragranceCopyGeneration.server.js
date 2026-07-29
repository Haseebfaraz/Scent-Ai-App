// Fix (vagueness diagnosis) — replaces the old fixed-vocabulary describeCharacter()/inline
// customerFacingWhySuits template with a small, note-aware OpenAI call, made only for the small
// number of proposals actually being returned to the customer (see
// recommendationEngine.server.js's generateNewProductCombinations) — never for every scored
// candidate. Runs in PARALLEL across the batch for latency (measured in testing: roughly 2-2.5x
// faster than a fully sequential per-item approach at typical batch sizes), with each item given a
// distinct static "opening angle" hint by its position so a batch doesn't converge on one generic
// template sentence. A cheap local post-check then looks for (a) a deterministic "never start with
// the word 'This'" rule violation — checked in code, not just left to the prompt, since testing
// showed the model still violates a prompt-only version of this rule sometimes — and (b) any
// accidental duplicate first-word/opening across the batch. Anything flagged gets exactly ONE
// targeted retry, with an explicit avoid-list AND a retry-specific angle distinct from other items
// retrying in the same wave (so two colliding items don't just collide with each other instead).
// Any call that fails outright (network/timeout/malformed JSON/leaked real product info) or still
// fails after its one retry leaves the proposal's customerFacingDescription/customerFacingWhySuits
// exactly as the caller already set them (its deterministic describeCharacter()/template fallback)
// — this module never blocks or overwrites on failure, and never needs to know how to compute that
// fallback itself. A duplicate that survives every repair step (measured in testing: rare, but
// real — more likely the more combinations in one batch share the same dominant note role) is only
// logged for monitoring; per the current design this is never retried further or blocked on.
const COPY_MODEL = "gpt-4.1-mini";
const COPY_REQUEST_TIMEOUT_MS = 12000;
const MAX_FIELD_LENGTH = 220;

// Mirrors app/routes/chat.jsx's own leak-guard pattern — duplicated (not imported) so this module
// has no dependency on a route file, and so it can check THIS specific text before it's ever
// stored or returned, not just the eventual full model reply.
const LEAKED_ID_PATTERN = /\bc[a-z0-9]{20,}\b/i;

const OPENING_ANGLES = [
  "open by naming the blend's own standout quality as the subject of the sentence",
  "open by addressing the customer directly — start with \"Your\" or \"You\"",
  "open around the occasion/moment it's for, or a sensory verb like \"Wearing\" or \"Reaching for\"",
  "open with the blend's dominant note or feeling as the very first word",
];

// Quoted verbatim from the main system prompt's "Presenting results" evidenceScope rule
// (app/routes/chat.jsx) as a literal string (not a shared import) so this module has no dependency
// on the route file — only used as a fallback constraint since this prompt bans popularity claims
// outright (that's customerFacingWeatherSuitability's separate, untouched job).
const EVIDENCE_SCOPE_RULE = `never say "in your area" or "in your region" unless evidenceScope is "city", "state", or "country"; if "season_global" say something like "this direction has shown wider interest during similar seasonal conditions" (never regional); if "global" say "broader interest among customers with similar preferences" (never regional); if "limited" say historical evidence is limited and lean on compatibility/stated preferences instead (never invent a popularity claim).`;

const BASE_RULES = `Rules:
- "description": one short phrase (roughly 4-10 words) describing the blend's actual character, grounded in the real notes given. Never a generic mood phrase disconnected from the actual notes.
- "whySuits": one short sentence on why this suits THIS customer, referencing their actual stated likes/preferred style/occasion where given. Never a generic catch-all sentence.
- Vary your sentence opening and structure every time. NEVER start "description" or "whySuits" with the word "This" as the literal first word.
- NEVER name a real product, SKU, product ID, internal handle, or any brand other than DUA. Describe only the blend's own character and notes.
- NEVER make any claim about regional, seasonal, or historical popularity (e.g. "popular in your area," "trending this season") — that is handled by a separate field elsewhere and phrased under its own strict rules. If you reference evidence at all, follow this exact constraint: ${EVIDENCE_SCOPE_RULE}
- Never contradict a stated dislike. Never invent a note, preference, or occasion beyond what's given below.
- Keep both fields brief and conversational — similar in length to "airy and bright" / "Designed around your preference for fresh scents." — not a paragraph.`;

function firstWordOf(text) { return text.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, ""); }
function openingOf(text, n = 4) { return text.trim().split(/\s+/).slice(0, n).join(" ").toLowerCase(); }

function textLeaks(text, catalogTitlesLowercase) {
  if (!text) return true;
  if (LEAKED_ID_PATTERN.test(text)) return true;
  const lower = text.toLowerCase();
  return catalogTitlesLowercase.some((title) => lower.includes(title));
}

function buildPromptInitial({ notesByRole, likes, dislikes, preferredStyle, occasion, confidence, evidenceScope, position, total }) {
  const angleHint = OPENING_ANGLES[position % OPENING_ANGLES.length];
  const system = `You write short, appealing customer-facing copy for a single custom DUA fragrance blend. You are given only the blend's real notes (grouped by the role each plays in the blend) and the customer's own stated preferences — nothing else about how the blend was built. This is recommendation ${position + 1} of ${total} being shown to the same customer in one reply — other recommendations are being written independently, so pick a genuinely distinct angle. Respond with a JSON object with exactly two string fields: "description" and "whySuits".

${BASE_RULES}
- ${angleHint}`;
  const payload = {
    notesByRole, likes: likes || [], dislikes: dislikes || [],
    preferredStyle: preferredStyle || null, occasion: occasion || null,
    confidence, evidenceScope,
  };
  return [{ role: "system", content: system }, { role: "user", content: JSON.stringify(payload) }];
}

function buildPromptRetry({ notesByRole, likes, dislikes, preferredStyle, occasion, confidence, evidenceScope, position, total, avoidOpenings, avoidFirstWords, retryAngleIndex }) {
  // Fix (Option 2, confirmed in testing) — angle is keyed by this item's index WITHIN the retry
  // wave, not its original batch position, so two items retrying together get distinct angles
  // from EACH OTHER, not just a shared "avoid wave 1" instruction that leaves them free to
  // converge on the same wording as one another.
  const angleHint = OPENING_ANGLES[retryAngleIndex % OPENING_ANGLES.length];
  const system = `You write short, appealing customer-facing copy for a single custom DUA fragrance blend. You are given only the blend's real notes (grouped by the role each plays in the blend) and the customer's own stated preferences — nothing else about how the blend was built. This is recommendation ${position + 1} of ${total} being shown to the same customer in one reply. Respond with a JSON object with exactly two string fields: "description" and "whySuits".

${BASE_RULES}
- RETRY — your previous attempt collided with another recommendation in this same batch (or broke a rule). You're one of several items being retried in this same repair pass — to avoid colliding with the OTHER retries too (which don't see your output either), use this distinct angle: ${angleHint}
- Separately, do NOT start "description" or "whySuits" with any of these already-used phrasings from the rest of the batch: ${avoidOpenings.length ? avoidOpenings.map((o) => `"${o}"`).join(", ") : "(none yet)"}. Do NOT use any of these as the first word: ${avoidFirstWords.map((w) => `"${w}"`).join(", ")}.`;
  const payload = {
    notesByRole, likes: likes || [], dislikes: dislikes || [],
    preferredStyle: preferredStyle || null, occasion: occasion || null,
    confidence, evidenceScope,
  };
  return [{ role: "system", content: system }, { role: "user", content: JSON.stringify(payload) }];
}

async function callCopyModel(messages) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), COPY_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: COPY_MODEL,
        messages,
        temperature: 0.5,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error("fragranceCopyGeneration: OpenAI API error", response.status, await response.text());
      return null;
    }
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return null;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const { description, whySuits } = parsed || {};
    if (typeof description !== "string" || typeof whySuits !== "string") return null;
    if (!description.trim() || !whySuits.trim()) return null;
    if (description.length > MAX_FIELD_LENGTH || whySuits.length > MAX_FIELD_LENGTH) return null;

    return { description: description.trim(), whySuits: whySuits.trim() };
  } catch (err) {
    console.error("fragranceCopyGeneration: request failed:", err.name === "AbortError" ? "timed out" : err.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Generates note-aware customerFacingDescription/customerFacingWhySuits for a whole batch of
 * proposals: parallel initial generation (distinct angle hint per position), one targeted parallel
 * retry wave for anything that collided or broke the "never start with This" rule, and a template
 * fallback for anything that still fails. Mutates each proposal's customerFacingDescription/
 * customerFacingWhySuits in place ONLY on success — a proposal that fails every repair step keeps
 * whatever customerFacingDescription/customerFacingWhySuits the caller already set on it (its
 * deterministic describeCharacter()/template fallback), so this module never needs to know how to
 * compute that fallback itself.
 *
 * @param {Array<{proposal: object, notesByRole: object}>} items
 * @param {{likes: string[], dislikes: string[], preferredStyle: string|null, occasion: string|null}} profileFields
 * @param {string[]} catalogTitlesLowercase - real catalog product titles, lowercased, for the
 *   leak-check (mirrors app/routes/chat.jsx's own getCatalogTitlesLowercase, but independent since
 *   this module has no route-file dependency).
 */
export async function applyCustomerFacingCopy(items, profileFields, catalogTitlesLowercase) {
  const total = items.length;
  if (!total) return;

  // ---- Wave 1: parallel, angle-hinted ----
  const initial = await Promise.all(items.map(async ({ proposal, notesByRole }, position) => {
    const result = await callCopyModel(buildPromptInitial({
      notesByRole, ...profileFields,
      confidence: proposal.confidence, evidenceScope: proposal.evidenceScope,
      position, total,
    }));
    return { proposal, notesByRole, position, result };
  }));

  // ---- Local, cheap check: leak-check + "this" violation + within-batch collision ----
  const accepted = [];
  const needsRetry = [];
  for (const item of initial) {
    if (!item.result) { item.reason = "hard-failure-no-retry"; needsRetry.push(item); continue; }
    if (textLeaks(item.result.description, catalogTitlesLowercase) || textLeaks(item.result.whySuits, catalogTitlesLowercase)) {
      item.reason = "leak-check-failed-no-retry";
      needsRetry.push(item);
      continue;
    }
    const fwDesc = firstWordOf(item.result.description);
    const fwWhy = firstWordOf(item.result.whySuits);
    const opDesc = openingOf(item.result.description);
    const opWhy = openingOf(item.result.whySuits);
    const thisViolation = fwDesc === "this" || fwWhy === "this";
    const collides = accepted.some((a) => a.opDesc === opDesc || a.opWhy === opWhy || a.fwDesc === fwDesc || a.fwWhy === fwWhy);

    if (thisViolation || collides) {
      item.reason = thisViolation ? "this-violation" : "collision";
      needsRetry.push(item);
    } else {
      accepted.push({ opDesc, opWhy, fwDesc, fwWhy });
      item.proposal.customerFacingDescription = item.result.description;
      item.proposal.customerFacingWhySuits = item.result.whySuits;
    }
  }

  // ---- Wave 2: ONE parallel retry pass for colliding/violating items only ----
  const avoidOpenings = [...new Set(accepted.flatMap((a) => [a.opDesc, a.opWhy]))];
  const avoidFirstWords = [...new Set(accepted.flatMap((a) => [a.fwDesc, a.fwWhy]).concat("this"))];

  await Promise.all(needsRetry.map(async (item, retryAngleIndex) => {
    // A hard network/parse failure or a leaked real product title never gets retried — the
    // proposal simply keeps its existing deterministic fallback.
    if (item.reason === "hard-failure-no-retry" || item.reason === "leak-check-failed-no-retry") return;

    const retryResult = await callCopyModel(buildPromptRetry({
      notesByRole: item.notesByRole, ...profileFields,
      confidence: item.proposal.confidence, evidenceScope: item.proposal.evidenceScope,
      position: item.position, total, avoidOpenings, avoidFirstWords, retryAngleIndex,
    }));
    if (!retryResult) return;
    if (textLeaks(retryResult.description, catalogTitlesLowercase) || textLeaks(retryResult.whySuits, catalogTitlesLowercase)) return;

    const fwDesc = firstWordOf(retryResult.description);
    const fwWhy = firstWordOf(retryResult.whySuits);
    const opDesc = openingOf(retryResult.description);
    const opWhy = openingOf(retryResult.whySuits);
    const stillBad = fwDesc === "this" || fwWhy === "this"
      || avoidOpenings.includes(opDesc) || avoidOpenings.includes(opWhy)
      || avoidFirstWords.includes(fwDesc) || avoidFirstWords.includes(fwWhy);
    if (stillBad) return; // keep the existing fallback

    item.proposal.customerFacingDescription = retryResult.description;
    item.proposal.customerFacingWhySuits = retryResult.whySuits;
  }));

  // ---- Monitoring only — logs, never blocks or retries further ----
  // Checked across the WHOLE final batch (initial accepts + successful retries + untouched
  // fallbacks), since even a fallback template can coincidentally match another item's opening —
  // a known, accepted limitation (fallback text was never designed to be checked against a live
  // batch). This is purely so real-world frequency can be observed; nothing here changes behavior.
  const fwSeen = new Map();
  const opSeen = new Map();
  for (const { proposal } of items) {
    for (const text of [proposal.customerFacingDescription, proposal.customerFacingWhySuits]) {
      if (!text) continue;
      const fw = firstWordOf(text);
      const op = openingOf(text);
      if (fwSeen.has(fw)) {
        console.log(`fragranceCopyGeneration: duplicate first word "${fw}" detected across returned batch (monitoring only, not blocked) — recommendationIds ${fwSeen.get(fw)} / ${proposal.canonicalKey}`);
      } else {
        fwSeen.set(fw, proposal.canonicalKey);
      }
      if (opSeen.has(op)) {
        console.log(`fragranceCopyGeneration: duplicate opening "${op}" detected across returned batch (monitoring only, not blocked) — recommendationIds ${opSeen.get(op)} / ${proposal.canonicalKey}`);
      } else {
        opSeen.set(op, proposal.canonicalKey);
      }
    }
  }
}
