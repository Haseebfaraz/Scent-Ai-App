// Merchant-facing documentation — plain-language explanation of how the chat bot and the
// recommendation engine actually work, for whoever is reviewing customer conversations/combinations
// in this app and wants to understand why a given result looks the way it does. Static content only
// (no loader/data) — kept in one file, next to the other admin routes, so it's easy to keep in sync
// as the underlying logic changes.
function Bullet({ children }) {
  return <s-text>• {children}</s-text>;
}

export default function Documentation() {
  return (
    <s-page heading="How the recommendation bot works">
      <s-link slot="breadcrumb-actions" href="/app">Customers</s-link>

      <s-section heading="Overview">
        <s-paragraph>
          The chat bot collects a customer's real preferences (likes, dislikes, location, occasion,
          style) through natural conversation, then a separate, fully deterministic scoring engine —
          not the chat AI itself — picks which real DUA products to combine into a new Hybrid,
          Tribrid, or Quadbrid. The AI only ever narrates results the engine already computed; it
          never invents a product, note, ratio, or score.
        </s-paragraph>
      </s-section>

      <s-section heading="1. Collecting the profile">
        <s-stack direction="block" gap="tight">
          <s-paragraph>
            The bot reacts to what the customer actually says rather than following a fixed script —
            if someone leads with "I need something for my wife's birthday in Chicago," it saves all
            of that immediately instead of asking again. For a quiet customer, it falls back to a
            default arc: a little rapport, a real occasion/activity to bridge from, their city
            (verified against real geocoding — never accepted just because it sounds plausible),
            dislikes, and occasion.
          </s-paragraph>
          <Bullet>Generic routine mentions (job, gym, a hobby) intentionally do NOT trigger a jump into fragrance talk — only a specific, one-off occasion (a wedding, an interview, a gift) does. This is enforced by a deterministic code gate, not just an instruction to the AI.</Bullet>
          <Bullet>A reply that reads like a mood/sentence rather than a real name (e.g. "not having a great day") is rejected before it can be saved as the customer's name.</Bullet>
          <Bullet>Once a real like/style signal exists, the bot does not ask a separate "what style or vibe do you like" question on top of it — one real answer is enough.</Bullet>
        </s-stack>
      </s-section>

      <s-section heading="2. Scoring real candidate products">
        <s-paragraph>
          Once the profile is ready, the engine scores real DUA products from five tiers running in
          parallel: same-city, same-state, same-country, and same-season real order history, plus a
          tier ranked purely by how well a product's real notes match what the customer said they
          like. Every product gets a real relevanceScore built from named point values (e.g. +5 for
          real same-city order evidence, +5 per matched liked family, −10 per disliked-family
          conflict) — never a number the AI made up.
        </s-paragraph>
        <s-stack direction="block" gap="tight">
          <Bullet>A "high" severity dislike conflict (roughly 3+ disliked-family notes, or ≥40% of a product's real notes) excludes that product outright. A single minor trace note never disqualifies a product on its own — that's a deliberate, spec-driven design choice.</Bullet>
          <Bullet>If a customer names a specific note (e.g. "Apple," "Sandalwood") rather than just a style word (e.g. "Fruity"), that literal note gets extra weight — and matching only counts a genuine whole-word match, so "Pineapple" never counts as "Apple" and a generic berry note never counts as "Strawberry."</Bullet>
        </s-stack>
      </s-section>

      <s-section heading="3. Building the actual combination">
        <s-paragraph>
          The top-scoring candidates become "anchors." Each anchor is paired with real, genuinely
          compatible supporting products (checked against a fixed compatibility table — e.g. fruity
          pairs well with citrus or musk, not with itself) to form a Hybrid (2 products), Tribrid (3),
          or Quadbrid (4). Every resulting combination is scored on real dimensions:
        </s-paragraph>
        <s-stack direction="block" gap="tight">
          <Bullet>Preference match — family-level matches, plus a bigger, tiered bonus for each of the customer's specifically-named notes actually present (1st note found: +10, 2nd: +7, 3rd and beyond: +5 each).</Bullet>
          <Bullet>Real order-history evidence — capped at +6 total, so strong regional popularity alone can never override a combination that better matches what the customer actually asked for.</Bullet>
          <Bullet>Risk factors — things like "several strongly fruity products competing" or "no contrasting role anywhere" each carry their own severity (a minor issue costs a couple of points; a structurally broken combination costs more). Two risk rules flagging the exact same underlying problem are only ever counted once.</Bullet>
          <Bullet>A combination naming zero of the customer's specifically-named notes, or containing a high-severity dislike conflict, is rejected outright — it can never simply be outscored, it's excluded from consideration entirely.</Bullet>
        </s-stack>
        <s-paragraph>
          After ranking, the engine checks whether every note the customer specifically named actually
          shows up somewhere across the results — not just in the winning one. If one is missing
          entirely, it searches the real catalog for products containing it and tries again with those
          included. If nothing in the catalog genuinely has it, that's reported honestly rather than
          invented.
        </s-paragraph>
      </s-section>

      <s-section heading="4. Confidence">
        <s-paragraph>
          Confidence is not a single guess — it's a blended read of five real dimensions (note data
          quality, real order-history evidence, compatibility/risk, similarity to existing
          combinations, and fit to this specific customer). Each dimension, and the overall confidence
          badge, can be clicked on the customer detail page to see exactly why it landed where it did,
          including the real risk factors and which of the customer's named notes made it in.
        </s-paragraph>
        <s-stack direction="block" gap="tight">
          <Bullet>Confidence is capped downward whenever real evidence is thin, the profile is incomplete, roles aren't complementary, or genuine risks were found — it can never read "very high" purely by accumulating small positive signals elsewhere.</Bullet>
          <Bullet>A customer in a region with little real historical order data will honestly see lower confidence more often — that's an accurate reflection of thin evidence, not a bug.</Bullet>
        </s-stack>
      </s-section>

      <s-section heading="5. Refining a recommendation (Recreate)">
        <s-paragraph>
          When a customer asks for a change ("make it sweeter," "I don't want sandalwood"), the same
          real vocabulary used everywhere else in the engine is reused to figure out what they mean —
          not a separate, narrower keyword list. A general stated dislike stays a soft signal (one
          incidental trace note never disqualifies a product). But something a customer explicitly
          asks to remove during a refinement is treated more strongly: every product containing even a
          trace of that family is excluded from that regeneration entirely, and the request is saved
          into the customer's real stored likes/dislikes so it carries forward, not just this one
          result.
        </s-paragraph>
      </s-section>

      <s-section heading="What this doesn't do">
        <s-stack direction="block" gap="tight">
          <Bullet>It never recommends a combination that already exists as a real Hybrid/Tribrid/Quadbrid.</Bullet>
          <Bullet>It never fabricates a note, product, score, or piece of order-history evidence that isn't real.</Bullet>
          <Bullet>Customer-facing copy can only mention a specifically-named note when that note actually appears in the selected products — never claims one that isn't really there.</Bullet>
          <Bullet>It can't guarantee a combination covering every single note a customer names if the real catalog simply doesn't have a product/pairing that contains all of them together — it always favors a real, honest result over an invented one.</Bullet>
        </s-stack>
      </s-section>
    </s-page>
  );
}
