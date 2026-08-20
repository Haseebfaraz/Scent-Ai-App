# Dua Scent AI — Project Architecture & Flow

A detailed, engineer-facing walkthrough of how this app actually works: the chat flow, how a
customer profile is built, how candidate products are fetched and scored, how a new fragrance
combination is generated and scored, how Odoo inventory feasibility gates the result, and how a
recommendation becomes a real Shopify product. Every section names the real file/function
responsible so this stays a map, not a paraphrase.

This document describes the **current implementation**. It is not a spec — it's a description of
what the code actually does, including the deliberate design decisions and known limitations.

---

## Table of contents

1. [System overview](#1-system-overview)
2. [Chat flow](#2-chat-flow)
3. [Customer profile construction](#3-customer-profile-construction)
4. [Candidate product fetching & analysis](#4-candidate-product-fetching--analysis)
5. [Preference / family matching system](#5-preference--family-matching-system)
6. [Combination generation & scoring](#6-combination-generation--scoring)
7. [Confidence & auto-confirmation](#7-confidence--auto-confirmation)
8. [Customer-facing copy generation](#8-customer-facing-copy-generation)
9. [Confirmation & persistence](#9-confirmation--persistence)
10. [Odoo inventory feasibility gate](#10-odoo-inventory-feasibility-gate)
11. [Preview page, Save Build & Add to Cart (product creation)](#11-preview-page-save-build--add-to-cart-product-creation)
12. [Admin dashboard](#12-admin-dashboard)
13. [Data model summary](#13-data-model-summary)
14. [Known limitations / deliberate trade-offs](#14-known-limitations--deliberate-trade-offs)

---

## 1. System overview

**Stack:** React Router (Remix-style) app embedded in Shopify Admin, PostgreSQL via Prisma, OpenAI
(`gpt-4.1-mini`) for conversation and copy generation, a storefront chat widget (theme app
extension) talking to this app's `/chat` route over Server-Sent Events, and a real external Odoo
instance for fragrance-oil inventory.

**The one rule that shapes everything below:** the chat AI never decides what to recommend. It
only narrates results a deterministic, testable scoring engine already computed. Every number a
customer sees — a ratio, a risk, a confidence badge, an evidence claim — traces back to a real
database row or a named point value in code, never an LLM guess.

```
Customer (storefront widget)
        │  POST /chat  (SSE)
        ▼
app/routes/chat.jsx ── builds system prompt, calls OpenAI, resolves tool calls
        │
        ├─► app/services/customerProfile.server.js        (structured profile, persisted)
        ├─► app/services/locationVerification.server.js    (city verification + weather)
        ├─► app/services/orderHistoryAnalysis.server.js     (candidate product scoring)
        ├─► app/services/recommendationEngine.server.js     (combination generation + scoring)
        ├─► app/services/fragranceCopyGeneration.server.js  (LLM-assisted, guarded copy)
        ├─► app/services/recommendationConfirmation.server.js (persist FragranceRecommendation)
        └─► app/tools/fragranceAgentTools.server.js          (glues all of the above to OpenAI tool calls,
                                                                also runs the Odoo feasibility gate)
        │
        ▼  preview_ready SSE event → browser navigates to
app/routes/apps.scent-library.fragrance-preview.jsx  (Shopify App Proxy page)
        │  Save Build / Add to Cart
        ▼
app/services/fragranceBuild.server.js  →  real Shopify product + variant created
```

Admin-side, `app/routes/app.customers.$conversationId.jsx` shows staff every recommendation ever
generated for a conversation — including full scoring/confidence/risk breakdowns and real-time
Odoo inventory evidence — and `app/routes/app.documentation.jsx` is a merchant-facing plain-language
explanation of the same system.

---

## 2. Chat flow

**File:** [app/routes/chat.jsx](../app/routes/chat.jsx)

### 2.1 Transport

`POST /chat` accepts `{ conversation_id, message, customer_email, customer_name }` and responds
with a `text/event-stream` of small JSON events: `id` (assigns/echoes the conversation id),
zero or more structured tool-result events (`profile_progress`, `preview_ready`, etc.), then
`chunk` (the actual reply text), `message_complete`, `end_turn`. `GET /chat?history=true` replays
a conversation's saved messages (used on page load/reload).

`customer_email`/`customer_name` come from the customer's **real, logged-in Shopify account** —
the storefront widget only renders chat behind `{% if customer %}`, so these are treated as
verified identity, never a self-reported or model-invented value.

### 2.2 Conversation memory

An in-memory `Map` (`CONVERSATIONS`) holds live message history per `conversationId` for speed,
but every message is also durably written to Postgres (`Conversation`/`Message` tables via
`db.server.js`). If the in-memory map is empty (e.g. after a Render cold start/redeploy wiped it),
`getConversation()` transparently rehydrates from the DB — so a customer's history and the AI's
own memory of it never drift apart just because the process restarted.

### 2.3 System prompt — deterministic gating, not just instructions

`buildSystemPrompt()` is rebuilt fresh on every turn (never cached) and injects the customer's
**already-saved structured profile** directly as a fact (`profileStatusLine`), so the model never
has to guess "what have I already asked?" — the backend, not the model's memory, is the source of
truth for conversation progress.

A key design decision: instructions like "don't ask about fragrance yet" are unreliable when
buried inside a long prompt that also discusses fragrance at length (confirmed live, repeatedly).
So the **early phase of a conversation is gated in code, not just in the prompt**:
`hasConcreteContext()` checks the customer's latest message against a fixed keyword pattern
(wedding, gift, interview, fragrance words, etc.). Until either 4-5 real exchanges have happened
or the customer has said something with real, specific context, the model is handed a
**deliberately short prompt that doesn't mention fragrance at all** — structurally incapable of
bridging into a scent conversation early, rather than being told not to and sometimes ignoring it.

Once unlocked, the full prompt governs: warm rapport → one genuine bridge into scent (never a
either/or "warm or fresh?" choice question — banned outright) → city (verified) → dislikes →
occasion → analysis. Every step is skippable the instant the customer already volunteered the
answer; the arc is a fallback for a quiet customer, not a script to force through.

### 2.4 The tool-resolution loop

`callAI()` runs up to 6 rounds of: call OpenAI with the 12 fragrance tools available → if it
returned `tool_calls`, execute each via `executeFragranceTool()` (in
`fragranceAgentTools.server.js`) → feed the tool result back as a `role: "tool"` message → repeat.
If the tool result carries a `preview_ready` SSE event, the loop **stops immediately** with a fixed
acknowledgment line — it deliberately never goes back to the model for one more round, because
that risked the model narrating "here are five options, which one?" after the browser was already
about to navigate to the preview page.

A 30-second `AbortController` wraps every OpenAI call so a hung request can't leave a customer's
chat bubble spinning forever; any failure mode (bad status, network error, timeout, malformed
JSON) collapses to the same clean fallback message.

### 2.5 The 12 tools (`FRAGRANCE_AGENT_TOOLS` / `executeFragranceTool`)

| Tool | Purpose |
|---|---|
| `save_customer_profile_field` | Persist one structured profile field (likes, dislikes, occasion, etc.) |
| `get_customer_profile` | Read back the profile + which required fields are still missing |
| `verify_customer_location` | Real geocoding/order-history city verification; also derives weather/climate direction automatically |
| `resolve_season_preference` | Resolves a real conflict between a customer-requested season style and today's actual weather |
| `analyze_customer_product_candidates` | Runs the deterministic candidate-scoring engine (§4) |
| `generate_new_product_combinations` | Runs the combination generator (§6), then auto-selects + auto-confirms the best one (§7) and opens a preview |
| `refine_combination_recommendations` | Same auto-select/auto-confirm behavior, but re-generates biased by fresh feedback ("make it sweeter") |
| `select_recommendation` / `confirm_product_combination` | Legacy manual-pick path, only relevant for an old conversation that predates auto-preview |
| `get_product_notes_and_combination_status` / `find_existing_combinations_for_product` / `find_combinations_using_similar_notes` / `check_exact_combination_exists` | Read-only catalog lookups the model can use to answer questions about a specific real product |

---

## 3. Customer profile construction

**Files:** [app/services/customerProfile.server.js](../app/services/customerProfile.server.js),
[app/services/locationVerification.server.js](../app/services/locationVerification.server.js),
[app/utils/weatherSeason.js](../app/utils/weatherSeason.js)

One `CustomerProfileState` row per `conversationId` (see §13), holding the entire
`CustomerFragranceProfile` shape as a single JSON blob (`emptyProfile()` defines every field with
its default). This is **not left to the model's memory** — it's the backend's own persisted state,
read fresh into the system prompt every turn.

Key fields and how they're actually set:

- **`name`/`email`** — Shopify account values always win over anything the model gathered
  conversationally; only asked for directly if the Shopify account genuinely has none.
- **`city`/`stateRegion`/`country`/`locationVerified`/`locationSource`** — set **only** by
  `verify_customer_location`, never by the model directly repeating what the customer typed. That
  tool does real geocoding and/or matches against real historical order data
  (`locationSource: "geocoding" | "order_history" | "customer_confirmed"`); a fictional or
  unmatchable city is rejected rather than silently accepted.
- **`weatherDirection`** — derived **automatically** the instant a city verifies (real live
  weather fetch → `deriveWeatherDirection()` in `weatherSeason.js` → one of
  `hot/warm/mild/cool/cold/humid/rainy`). Never asked about directly; this replaced an earlier
  design where a "current season" was silently computed from the calendar and injected into the
  prompt, which is what caused a documented real bug ("I've saved that it's summer" when the
  customer never said that).
- **`requestedSeasonStyle`** — the opposite of the above: set **only** when the customer
  *explicitly* asks for a seasonal style ("something wintery"), never inferred. If it genuinely
  conflicts with `weatherDirection` (`hasSeasonWeatherConflict()`), the model asks one brief
  clarifying question, then calls `resolve_season_preference` once.
- **`likes`/`dislikes`/`preferredStyle`/`occasion`** — free text saved the moment the customer
  expresses any of them, from anywhere in the conversation (not tied to a fixed question order). A
  single reply naming both a like and a dislike ("spicy and fresh, but not strong") saves both.
- **`dislikesAsked`/`occasionAsked`** — booleans distinguishing "never asked" from "asked, and the
  real answer was none" — required before analysis can run, so a customer is never silently
  assumed to have zero dislikes just because they didn't mention any.
- **`giftRecipient`** — set the moment the conversation reveals this is for someone else; from
  then on, `likes`/`dislikes`/`preferredStyle`/`occasion` describe the **recipient**, not the buyer.

`getMissingRequiredFields()`/`isProfileReadyForAnalysis()` are the single source of truth for
"is this profile ready?" — city (verified), country, and at least one like-or-preferredStyle,
`dislikesAsked` and `occasionAsked` both true.

---

## 4. Candidate product fetching & analysis

**File:** [app/services/orderHistoryAnalysis.server.js](../app/services/orderHistoryAnalysis.server.js)
— backs the `analyze_customer_product_candidates` tool.

This is the first of two scoring stages. Its job: given a real profile, come back with up to 15
real, catalog-backed `ProductCandidate` rows (never invented), each carrying its own real evidence.

### 4.1 Five parallel tiers feed one candidate pool

| Tier | Source | Notes |
|---|---|---|
| City | Live `OrderHistory` aggregation (`groupBy`) | A single city's row count is always small, so this is fast without precomputing |
| State | `ProductRegionSummary` (precomputed) | A live country-scoped `groupBy` measured ~12s in testing (87% of 936k rows) — too slow for a chat turn |
| Country | `ProductRegionSummary` (precomputed) | Same reason |
| Season | `ProductRegionSummary` (precomputed) | Resolved through `SEASON_ALIASES` since the source data spells season names inconsistently |
| **Like-match** | Live full-catalog scan (`topProductsByLikeMatch`) | Ranks every real product by `likeMatchStrength()` against the customer's stated families — this is the tier that lets a genuinely well-matching product become a candidate even with **zero** regional order history |

`ProductRegionSummary` is populated by `scripts/build-region-summary.cjs`, an offline batch job —
not computed live by the running app.

### 4.2 Per-candidate scoring — `relevanceScore`

Once the pool of candidate names is assembled, each is scored (weights from
`fragranceScoring.js`'s `SCORE_WEIGHTS`, the single named source of truth for every point value):

```
+5   same-city order evidence exists
+4   same-country order evidence exists
+3   same-state/climate order evidence exists
+4   same-season order evidence exists
+5   per matched liked family (flat, boolean — not strength-weighted at this stage)
+2.5 per literal customer-named note actually present (a tie-breaker within the like-match tier)
-10  per matched disliked family
+3   repeat-purchase evidence from a similar customer
+2   popularity among ≥5 distinct similar customers
+ (2 × weight) per matched lifestyle-preferred direction (office/gym/relaxation/etc., from occasion text)
```

A **hard pre-generation exclusion** happens before scoring even starts: a "high" severity dislike
conflict (`classifyDislikeConflict`, §5) or a failed sensitivity filter (`passesIntensityFilter`,
for a customer whose language signals high fragrance sensitivity) removes a product from
consideration entirely — it's never scored, never shown, never a candidate.

The pool is sorted by `relevanceScore` descending (tie-broken by total real order volume) and
capped at 15 (`MAX_CANDIDATES_RETURNED`).

---

## 5. Preference / family matching system

**Files:** [app/utils/fragranceCompatibility.js](../app/utils/fragranceCompatibility.js),
[app/utils/fragranceScoring.js](../app/utils/fragranceScoring.js)

This is the shared vocabulary every scoring stage in the app reads from — one set of keyword
lists, never duplicated per feature.

### 5.1 Two tiers of family definitions

- **`PREFERENCE_FAMILIES`** — the families a customer's stated likes/dislikes actually resolve
  against: `fruity, sweet, fresh, spicy, strongHeavy, woody, musk, powdery, dry, earthy, natural,
  floral`. Every keyword list is a case-insensitive **substring** match against a product's real
  notes (deliberately, not word-boundary — see §14 for the one known trade-off this causes).
- **`COMPATIBILITY_TAGS`** — additional descriptors (`citrus, musk, vanilla, aquatic, woody,
  aromatic, smoky, amber`) used only for pair-compatibility scoring and a couple of risk rules —
  never for matching a customer's stated preference.

`detectFamilies(notes, familyMap)` is the one generic function both tiers share.
`textToPreferenceFamilies(likes)` maps a customer's own words ("Floral", "Fruity") onto
`PREFERENCE_FAMILIES` keys the same way it maps a product's real notes — so a customer's stated
family and a product's detected family are always compared on equal footing.

### 5.2 Graded, not just boolean, matching

- **`matchedLikes(notes, likeFamilies)`** — which stated families a product matches at all
  (boolean presence).
- **`likeMatchStrength(notes, family)`** — what **fraction** of a product's real notes fall in
  that family. A product with one incidental trace note scores far lower than one genuinely built
  around that family — this is what lets `preferenceScore` (§6) distinguish "this happens to
  contain Vanilla" from "this is a vanilla fragrance."
- **`literalNoteTermsFromLikes()`** / **`exactNoteCoverageScore()`** — when a customer names a
  *specific* note ("Apple", "Sandalwood") rather than a style word, that gets its own, bigger,
  tiered bonus (1st distinct note +10, 2nd +7, 3rd+ +5 each) — always bigger than the flat
  family-level bonus, and matched via whole-word matching (`containsWholeWord`) so "Pineapple"
  never counts as "Apple."
- **`familyBreadthCoverageScore()`** — rewards a combination covering **two or more distinct**
  stated families (e.g. "Fresh, Floral") over one that just repeats the same family across
  components, without double-counting a repeated family.

### 5.3 Dislike handling

`splitDislikesByExactness()` divides a stated dislike into two buckets:

- **`exactNoteDislikes`** — a specific real note named literally (e.g. "Sandalwood") →
  `hasHardExcludedTerm` rejects any product containing it, full stop, independent of severity.
- **`explicitFamilyDislikes`** — a bare style/family word (e.g. "Woody fragrances") → the softer,
  graded `classifyDislikeConflict()` path: severity scales with how many of a product's notes hit
  the disliked family and whether the hit is among the first 3 notes (more "prominent"). Only
  "high" severity (≥3 matched notes or ≥40% of the product) hard-excludes; a single minor trace
  note never disqualifies a product on its own — a deliberate design choice, not an oversight.

### 5.4 Risk rules

`RISK_RULES` (in the same file) are 8 deterministic checks against a proposed combination —
excessive gourmand notes in hot weather, multiple heavy/oud components, competing fruits, spice
clash, citrus/smoke clash, Quadbrid complexity, powdery overload, and "every component shares one
direction with no contrast" (`duplicate_direction`). Each carries a severity
(advisory/low/medium/high/critical); correlated hits (the same underlying problem tripping two
rules at once) are grouped so only the highest-severity one counts toward the penalty —
`groupAndPenalizeRisks()`.

---

## 6. Combination generation & scoring

**File:** [app/services/recommendationEngine.server.js](../app/services/recommendationEngine.server.js)
— `generateNewProductCombinations()`, backs the `generate_new_product_combinations` /
`refine_combination_recommendations` tools.

This is the second scoring stage — turning scored *candidates* into scored *combinations*.

### 6.1 Anchors and support shortlists

The top-scoring candidates (by `relevanceScore`) become **anchors** — the real product each new
combination is built around (`MAX_ANCHORS = 5`). Each anchor is paired with its own shortlist of
genuinely compatible supporting products (`buildSupportShortlistForAnchor`) — compatibility is
decided by `pairIsCompatible()` (a fixed table of family pairs that legitimately complement each
other, e.g. fruity+citrus, woody+amber), not raw note overlap, so near-identical product-line
siblings don't crowd out genuinely different, complementary pairings.

For each `(anchor, support-combination)` pair, across every allowed type (Hybrid = 2 products,
Tribrid = 3, Quadbrid = 4), a candidate combination is built and scored by
`scoreProposedCombination()` — unless it's already an exact match for a real
`ExistingCombination` row (never recommended as "new"), or a near-duplicate of another product
already in the combo (`noteOverlapRatio`).

### 6.2 Hard gates (reject the whole combination outright)

Before any scoring happens, a combination is rejected (`return null`, never scored, never shown)
if:
- Two components are near-duplicates of each other.
- The same product appears twice.
- Two or more components have **no detected family at all** (no clear role).
- Any component contains an exact-note dislike, or a "high" severity family dislike conflict.
- A "critical" severity risk is present (mechanism exists; no current rule uses it).
- The customer stated real liked families and **none** of them are present anywhere in the combo.
- The customer named specific literal notes and **none** of them are present anywhere in the combo.

### 6.3 Scored dimensions (`finalScore`)

```
preferenceScore        family-match bonus (likeMatchStrength-weighted) + breadth bonus + exact-note tiers
seasonalScore           +4 unless a summer-heat gourmand-overload risk fired
historyScore            anchor's real order-history evidence, capped at +6 (never lets popularity alone dominate)
compatibilityScore      +5 per genuinely compatible product PAIR (not per family combination)
analogousScore          +2 per real existing combination sharing notes with this one
balanceScore            +10 unless a "no contrasting role" risk fired
conflictPenalty         -2/-5 per low/medium dislike-family conflict found
styleMatchScore         +3 per matched preferredStyle direction (capped, not summed per product)
avoidedDirectionPenalty -5 per direction a sensitive customer's own words said to avoid
lifestyleMatchScore /
lifestyleConflictPenalty   same idea, keyed off occasion/lifestyle text instead of preferredStyle
powderyContextPenalty   -8 if 2+ powdery components AND the customer's own signals point light/airy
complexityPenalty       scales with combined unique note count, harsher if the customer prefers simple blends
typeSimplicityScore     a real, always-on bias toward Hybrid over Tribrid/Quadbrid (not just for sensitive customers)
riskPenalty             severity-weighted, correlation-deduplicated total from the 8 risk rules
```

Results across all anchors are pooled, sorted by `finalScore` descending, and passed through
`selectDiverseResults()` before being capped to `maximumResults` (default 8). A batch-wide pass
then checks whether every customer-named literal note is covered **somewhere** in the final
batch (not just any one combo) — if one is missing entirely, a small, targeted set of real catalog
products containing it are seeded as extra anchors and the batch is regenerated once.

### 6.4 Ratios and roles

`assignRoles()` classifies each component by whichever detected family has the **most** matching
notes overall (not just the first family checked) — `Freshness`, `Main fruit body`, `Sweetness`,
`Floral bridge`, `Musk/wood base`, `Longevity support`, or `Contrast` if nothing detected.
`computeRatios()` turns roles into a real percentage split (parts-based, e.g. Freshness/fruit
roles get more weight than a supporting role), with a hard cap so no single sweet/heavy component
can dominate the blend — always renormalized to exactly 100%.

---

## 7. Confidence & auto-confirmation

**Files:** `recommendationEngine.server.js` (confidence bands),
[app/tools/fragranceAgentTools.server.js](../app/tools/fragranceAgentTools.server.js)
(`evaluateAutoConfirmEligibility`, `autoSelectAndConfirmBest`).

### 7.1 Confidence

A blended `confidence` (`low`/`medium`/`high`/`very high`) starts from `finalScore` + risk count,
then is **capped downward** (never up) by a chain of hard rules: zero real history evidence, an
unverified location, non-complementary roles, an unresolved season conflict, any risk present, an
incomplete profile, thin evidence scope, a serious risk load, or (for a sensitivity-flagged
customer) combined complexity outpacing what "simple" was asked for.

A **multi-dimensional breakdown** (`confidenceBreakdown`) exposes five separately-computed
dimensions customers/staff can inspect: data quality, historical evidence scope, compatibility,
novelty (vs. existing combinations), and customer fit — each a deterministic banding of a value
already computed above, not new machinery.

### 7.2 Auto-select-and-confirm (`autoSelectAndConfirmBest`)

Every ranked combination is **saved immediately** as its own pending `FragranceRecommendation` row
— not just the eventual winner. The engine then walks the ranked list, and for the first candidate
that passes **every** independent re-check, it confirms that one and stops:

1. `evaluateAutoConfirmEligibility()` — deterministic, no network call: no hard dislike conflict
   (re-checked independently, not just trusted from generation), valid shape, no high/critical
   risk, `customerFitConfidence` not "low", `compatibilityConfidence` not "low".
2. **Odoo inventory feasibility** (§10) — the *only* network-dependent check, and only ever run for
   the one candidate currently being considered (never eagerly for every ranked candidate — this
   fixed a real, measured 30s+ latency regression).

If a candidate fails either check, the engine tries the next-ranked one — the same fallback
pattern used everywhere else (a vanished catalog product, a failed re-verification, etc.).

---

## 8. Customer-facing copy generation

**File:** [app/services/fragranceCopyGeneration.server.js](../app/services/fragranceCopyGeneration.server.js)

Every other customer-facing field (`customerFacingBestUse`, `customerFacingWeatherSuitability`,
`customerFacingStrength`, `customerFacingRisk`) is generated deterministically from already-scored
data (no LLM call). Only `customerFacingDescription`/`customerFacingWhySuits` go through a small,
guarded LLM call (`gpt-4.1-mini`) — made **once per returned proposal**, in parallel, never for
every scored-but-discarded candidate.

Guardrails, all checked in code (not just prompted for):
- Never starts with the literal word "This" (checked deterministically; a prompt-only version of
  this rule was confirmed to fail sometimes).
- Never leaks a real catalog product title or an internal database ID into the generated text.
- Never claims a specific named note the customer asked about if this exact combination doesn't
  actually contain it (`mentionsUnearnedExactNote`).
- Never claims a stated preference *family* the customer asked about if this combination's
  `missingPreferenceFamilies` says it isn't actually represented (`mentionsUnmatchedFamily`).
- One targeted retry if a violation, leak, or cross-item duplicate-opening is detected within the
  same batch; if the retry still fails, the proposal keeps its safe deterministic fallback text
  (which only ever names an actually-matched family, never a specific note) — the LLM step can
  never make things worse than the fallback it's allowed to fall back to.

---

## 9. Confirmation & persistence

**File:** [app/services/recommendationConfirmation.server.js](../app/services/recommendationConfirmation.server.js)

`saveRecommendation()` writes one immutable `FragranceRecommendation` row per generated
combination (deduplicated against any other still-valid pending/confirmed row for the same
conversation with the same `canonicalKey`, so two generation calls scoring the same top candidate
never mint two rows). Internal fields (`productsJson`, real notes, raw `scoreJson`, `evidenceJson`)
are stored separately from `customerFacingJson` — the **only** subset any customer-facing surface
(SSE payload, recommendation card, chat text) is ever allowed to read from.

`confirmRecommendation()` flips `status` to `confirmed` only after re-verifying, at that exact
moment, that every component still exists in the real catalog, the ratios still sum to 100%, and
this exact pairing still isn't already a real product — defense against something changing in the
moments between generation and confirmation.

---

## 10. Odoo inventory feasibility gate

**Files:** [app/services/odooClient.server.js](../app/services/odooClient.server.js) (raw HTTP),
[app/services/odooInventory.server.js](../app/services/odooInventory.server.js) (normalization +
caching), [app/services/recommendationInventorySnapshot.server.js](../app/services/recommendationInventorySnapshot.server.js)
(persistence), wired into `evaluateCandidateInventory()` in `fragranceAgentTools.server.js`.

### 10.1 The real contract

```
GET {ODOO_INVENTORY_URL}?skus=SKU_A,SKU_B
Authorization: Bearer {ODOO_INVENTORY_API_KEY}
→ { "success": true, "products": [{ "name", "default_code", "on_hand_qty" }] }
```

Genuinely batched — every component of one candidate is checked in a **single** real HTTP request,
not one call per component. A short-lived in-memory cache (60s default) avoids repeating the same
lookup for a product that recurs across several candidates in one turn, and an 8-second timeout
bounds the worst case so a slow/unreachable Odoo can never hang a chat turn.

### 10.2 The oil/alcohol formula

Every finished bottle is a fixed 34ml: 12–14ml (13ml default, `fragranceFormula.server.js`) is
fragrance oil, the rest is alcohol. A component's ratio percentage applies **only to the oil
portion**, never the whole 34ml — `requiredOilMl = 13 × (ratioPercent / 100)`.

### 10.3 Final gate, not eager per-candidate check

Odoo is checked **only for the one candidate currently under consideration** inside
`autoSelectAndConfirmBest`'s ranked walk — never for every ranked candidate up front (that used to
repeat the same lookup across most candidates and pushed a generation turn past 30s).

### 10.4 WARN/fallback semantics

Only a **confirmed** "not enough oil" answer (a real, successfully-resolved SKU whose
`on_hand_qty` is genuinely below what's required) makes a candidate not buildable. A missing SKU
mapping, an SKU Odoo doesn't recognize, or a request/network failure is honestly reported as
**not validated** — never silently treated as a pass, and never wrongly treated as a hard failure
either. This is deliberate: `STRICT` rejection mode is intentionally not enabled until the
endpoint has a track record of real, successful lookups.

### 10.5 Persisted, immutable evidence

Whatever Odoo said at the exact moment a candidate was checked — buildable or not, validated or
not, the real stock number behind each component — is saved once as a
`RecommendationInventorySnapshot` (+ per-component `RecommendationInventoryComponent` rows) and
**never rewritten later**, even if Odoo's live stock changes afterward. A future Save Build/Add to
Cart check is explicitly a separate, later, fresh lookup. Snapshots are only ever created for a
candidate that actually reached this gate — never for one rejected earlier by the deterministic
checks in §7.2.

---

## 11. Preview page, Save Build & Add to Cart (product creation)

**Files:** [app/routes/apps.scent-library.fragrance-preview.jsx](../app/routes/apps.scent-library.fragrance-preview.jsx),
[app/services/fragranceBuild.server.js](../app/services/fragranceBuild.server.js),
[app/utils/previewUrl.server.js](../app/utils/previewUrl.server.js),
[app/utils/fragrancePricing.js](../app/utils/fragrancePricing.js)

### 11.1 No Shopify product exists yet

Confirming a recommendation in chat **never** creates a real Shopify product. It only opens the
preview page (`buildPreviewUrl()` — routed through the Shopify App Proxy, `/apps/scent-library/...`,
so the URL lives on the merchant's own storefront domain, not this app's Render domain). Everything
up to this point — including the whole Odoo feasibility check — is entirely speculative.

### 11.2 The preview page itself

The preview's loader re-derives everything it shows from the saved `FragranceRecommendation` row:
real notes are bucketed into **Top/Middle/Base** positions (`computeNotePositionBuckets`, a shared
deterministic classifier — never duplicated between backend and frontend), a default Top/Middle/
Base ratio is computed from how many real notes landed in each bucket
(`computeDefaultRatios`), and a live per-position `$/5ml` rate is computed
(`computePricePer5mlByPosition`) so dragging a ratio slider client-side recomputes price instantly
via the same shared formula (`fragrancePricing.js`'s `estimateTotalPrice`) without a server round
trip.

### 11.3 Three actions

- **Recreate** — saves the current preview state as an internal draft only (no Shopify
  product/cart), flags the conversation so it resumes with "What would you like to change about
  your fragrance?" the next time the storefront widget reopens.
- **Save Build** — first time: creates a real Shopify product via `createShopifyBuildProduct()`
  (below). Every subsequent save on the *same* already-created product reuses the existing
  `api.save-build.jsx` endpoint (resolve-or-create a variant for the new ratio), rather than
  duplicating its tolerance-matching/pricing logic.
- **Add to Cart** — same creation/resolution path as Save Build, then redirects straight to
  Shopify's cart permalink (`/cart/{variantId}:1`) so the product is added and the cart opens in
  one navigation.

### 11.4 Real product creation (`createShopifyBuildProduct`)

Builds a genuine Shopify product using the **Top/Middle/Base Note** three-option shape
(`api.save-build.jsx`'s existing, unmodified contract): each option's single value is the real,
comma-joined note list for that position plus a ratio suffix (e.g. `"Bergamot, Lemon (34%)"`).
Product-level metadata is split deliberately:
- `note_composition` metafield — the real layer breakdown, safe/expected to be customer-visible.
- `internal_components` metafield — real source product titles/roles, admin-only by design, never
  shown on the storefront option values.
- `customer_name`/`customer_email` metafields — attribution, not shown to other shoppers.

Price is computed per-position (§11.2's shared formula) and summed; the product is published to
every sales channel and given a real bottle image before the variant price is set via
`productVariantsBulkUpdate`. `FragranceRecommendation.buildStatus` moves `draft → saved` only once
this succeeds; `shopifyProductId`/`shopifyVariantId` are then the permanent link between the
recommendation and the real product.

---

## 12. Admin dashboard

**Files:** [app/routes/app.customers.$conversationId.jsx](../app/routes/app.customers.$conversationId.jsx),
[app/routes/app.documentation.jsx](../app/routes/app.documentation.jsx)

The customer detail page lists every recommendation ever generated for a conversation (not just
the confirmed one), each showing: status/type/confidence badge (clickable for the full
five-dimension breakdown), real ratio, real components with real notes, why-this-suits-them copy,
and an **Inventory** section sourced entirely from the persisted `RecommendationInventorySnapshot`
— three honest states (✅ Buildable / ❌ Not buildable / ⚠ Not validated), a real per-component
stock table, and totals. Opening this page **never** triggers a new Odoo call — it only reads back
what was already recorded at generation time.

`app.documentation.jsx` is the plain-language, merchant-facing counterpart of this document —
static content describing the same system in non-technical terms for whoever is reviewing
conversations day to day.

---

## 13. Data model summary

Key Prisma models (`prisma/schema.prisma`) and what they're for:

| Model | Purpose |
|---|---|
| `Conversation` / `Message` | Durable chat history, mirrors the in-memory `CONVERSATIONS` map |
| `CustomerProfileState` | One row per conversation — the entire structured `CustomerFragranceProfile` |
| `FragranceProduct` | The real catalog — title, notes (`notesJson`), fragrance family, collection, price |
| `ExistingCombination` | Every real, already-published Hybrid/Tribrid/Quadbrid — never re-recommended as "new" |
| `OrderHistory` | 936k+ real historical order rows (city/state/country/season/product) |
| `ProductRegionSummary` | Precomputed state/country/season aggregates (offline batch job) |
| `FragranceRecommendation` | One immutable row per generated combination — internal fields, customer-facing fields, full `scoreJson`/`evidenceJson`, build status |
| `RecommendationInventorySnapshot` / `RecommendationInventoryComponent` | Immutable historical Odoo feasibility evidence, one snapshot per candidate actually checked |
| `OdooOilMapping` | Real DUA product ↔ Odoo oil SKU mapping (many-to-one allowed — some products share one physical oil) |
| `CustomerAccountUrls` / `CustomerToken` / `CodeVerifier` | Customer Account API OAuth plumbing |
| `Session` | Shopify Admin API session storage |

---

## 14. Known limitations / deliberate trade-offs

These are documented, intentional, and mostly covered by regression tests — not oversights:

- **Substring family matching** (§5.1) — e.g. bare `"rose"` also matches inside `"Rosemary"`.
  Switching to word-boundary matching globally was evaluated and rejected: it would break other
  deliberate substring behaviors this same file relies on (`"musk"` matching `"musky"`, the
  `"berr"` fragment catching Raspberry/Blackberry, `"amber"` matching `"Ambergris"`). Accepted as a
  small, measured cost (a real catalog check found this affects a small minority of products) in
  exchange for not risking a much bigger, harder-to-verify global change.
- **Odoo `STRICT` mode is off by default** — a lookup failure or missing mapping is reported as
  "not validated," never silently treated as a pass. This is a deliberate WARN-first rollout, not
  a gap: enabling `STRICT` rejection is a conscious decision for once the endpoint has a longer
  track record of real, successful lookups.
- **Odoo returns no unit-of-measure field** — the integration assumes on-hand quantities are
  already in ml (the documented production unit), centralized in one place
  (`odooInventory.server.js`) rather than re-asserted throughout the codebase, specifically so this
  assumption is easy to find and change later if it turns out to be wrong.
- **Anchor selection favors historical popularity** — the combination generator's anchor list is
  currently a straight top-N sort by `relevanceScore`, which weights real regional order history
  more heavily than a customer's stated preference strength. A strongly preference-matched but
  historically-thin product can be present in the candidate pool yet still not become an anchor.
  Understood, reproduced against real data, and intentionally not yet changed in this pass.
