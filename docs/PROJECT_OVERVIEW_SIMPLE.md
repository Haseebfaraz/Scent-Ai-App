# How Dua Scent AI Works — A Simple Guide

*A plain-language walkthrough for anyone who isn't a developer — no technical background needed.*

## What is this, in one sentence?

It's a chat assistant on the website that talks to a customer like a helpful perfume expert,
learns what they like, and then either recommends one of our existing fragrances or — if nothing
existing is quite right — designs a brand-new custom blend for them from real ingredients, checks
that we can actually make it, and lets them preview, adjust, and buy it.

Nothing here is guessed or made up. Every recommendation is built from real products, real past
order history, and (for a brand-new blend) a real check of our actual fragrance-oil stock before
it's ever offered.

---

## The big picture

```
                         ┌───────────────────────────────┐
                         │   1. Customer starts chatting   │
                         └───────────────────────────────┘
                                        │
                                        ▼
                         ┌───────────────────────────────┐
                         │  2. The assistant gets to know  │
                         │      the customer                │
                         └───────────────────────────────┘
                                        │
                                        ▼
                         ┌───────────────────────────────┐
                         │  3. We look at real past orders  │
                         │     to find great matches        │
                         └───────────────────────────────┘
                                        │
                                        ▼
                         ┌───────────────────────────────┐
                         │  4. A brand-new blend is         │
                         │     designed, just for them      │
                         └───────────────────────────────┘
                                        │
                                        ▼
                         ┌───────────────────────────────┐
                         │  5. We double-check it can        │
                         │     actually be made (real stock) │
                         └───────────────────────────────┘
                                        │
                                        ▼
                         ┌───────────────────────────────┐
                         │  6. Customer previews it and     │
                         │     can fine-tune it              │
                         └───────────────────────────────┘
                                        │
                                        ▼
                         ┌───────────────────────────────┐
                         │  7. They save it or add it to     │
                         │     cart                          │
                         └───────────────────────────────┘
                                        │
                                        ▼
                         ┌───────────────────────────────┐
                         │  8. A real, ready-to-sell         │
                         │     product is created             │
                         └───────────────────────────────┘
```

Each of those 8 steps is explained below, in plain terms.

---

## 1. Customer starts chatting

A customer opens the chat widget on the storefront (only available once they're logged into their
account, so we always know who we're talking to). There's no form to fill out and no menu to pick
from — it's a normal, back-and-forth conversation, the way you'd talk to a knowledgeable person at
a fragrance counter.

## 2. The assistant gets to know the customer

Before recommending anything, the assistant naturally gathers a few things — not as a rigid
questionnaire, but by actually listening to what the customer says:

- **Their name** (skipped if we already know it from their account)
- **A little bit about their day or what they're up to** — this is just genuine conversation, not
  data collection, but it often reveals useful hints (a wedding coming up, a gift for someone,
  their general vibe)
- **Their city** — checked against a real map/location service, so we don't just take a made-up
  place at face value. The moment we know their city, we can also tell today's real weather, which
  quietly influences the kind of scent that makes sense (nobody wants a heavy winter scent
  recommended on a 95°F day)
- **What they like and don't like** — specific notes ("I love vanilla"), a general style ("fresh
  and clean"), or both
- **What it's for** — everyday wear, a special occasion, or a gift for someone else

Everything the assistant learns is saved permanently to that customer's profile, so they're never
asked the same question twice — not in this conversation, and not in a future one either.

If it's a gift, the assistant smoothly shifts to asking about the *recipient's* taste instead of
the customer's own, so the final scent actually suits the person who'll wear it.

## 3. We look at real past orders to find great matches

This is the important part: **nothing here is a guess.** Once we know enough about the customer,
the system searches our real historical order data — what people in their city, region, and
country have actually bought, especially during the same season/weather — and cross-references
that against real product ingredients that match what the customer said they like.

This produces a shortlist of genuinely strong candidates, each backed by real evidence like "16
people in this city have ordered this before" or "this contains real Jasmine and Rose, which
matches their stated love of florals." Nothing on this list is invented to sound good — if the
evidence is thin, that's shown honestly rather than dressed up.

## 4. A brand-new blend is designed, just for them

If an existing fragrance isn't quite the right fit, the system can design something new by
thoughtfully combining two, three, or four real existing products into one new blend — never
inventing a new "ingredient" that doesn't exist, only combining real ones in a new way.

It automatically works out:
- Which real products pair well together (so it doesn't combine two things that would clash or
  feel repetitive)
- What percentage of each one should go into the final bottle
- Whether this exact combination has already been made before (if so, it won't offer it again as
  "new")

It also runs the new blend through a checklist of common-sense red flags — for example, "is this
overloaded with heavy, wintery notes for someone who wants something light and everyday?" or "does
this actually reflect what they said they like, or did it just happen to be popular?" A blend that
raises a real concern is simply not offered; a better one is tried instead.

Out of everything it could build, the single best-fitting option is automatically chosen — the
customer is never shown a confusing list of five options to pick from. It just knows.

## 5. We double-check it can actually be made (real stock)

Before this new blend is ever shown to the customer, the system does one more real check: it asks
our actual inventory system whether we genuinely have enough of the real fragrance oils on hand to
make it. This is a live check against real stock numbers, not an assumption.

- If we clearly don't have enough of something, that option is quietly skipped and the next-best
  blend is tried instead — the customer never sees a recommendation we can't actually deliver.
- If the stock check itself can't be completed for some reason (a temporary connection issue,
  for example), the system is honest about that too rather than either falsely promising it's
  available or wrongly blocking a good recommendation — it's flagged plainly as "not confirmed"
  behind the scenes, and staff can see exactly what happened on the admin side.

A permanent record of exactly what was checked, and what the real answer was at that moment, is
kept for every recommendation — so if a question ever comes up later about why something was or
wasn't recommended, there's a real, honest paper trail.

## 6. Customer previews it and can fine-tune it

The moment a recommendation is ready, the customer is taken straight to a preview page — no extra
clicking, no "would you like to see it?" question. It shows:

- A suggested name for their custom scent (which they can rename)
- The real ingredients, grouped simply into "what you smell first," "the heart of the scent," and
  "what lingers longest"
- Sliders letting them nudge the balance between those three groups, with the price updating live
  as they adjust
- A short, honest explanation of why this suits them

At this point, nothing has been created yet in our store — it's still just a preview. The customer
can also ask to start over ("Recreate"), which brings them right back into the conversation to
describe what they'd like changed.

## 7. They save it or add it to cart

Once they're happy with it, the customer has two options:
- **Save it** — creates the real product in our store so they (or the team) can come back to it
  later.
- **Add to Cart** — creates the real product *and* takes them straight to checkout in one step.

## 8. A real, ready-to-sell product is created

Only at this final step does a genuine, purchasable product get created in the store — with the
real ingredients, a real calculated price based on the actual materials used, a proper product
photo, and it's made visible everywhere the store normally sells. Before this moment, everything
was just a preview — nothing was ever created speculatively or by accident.

---

## Why this can be trusted

- **Nothing is invented.** Every product, ingredient, price, and piece of "people in your area
  loved this" evidence traces back to something real — a real product, a real past order, a real
  stock check. If the evidence is thin, that's shown honestly instead of being dressed up to sound
  more confident than it is.
- **The chat assistant never decides anything on its own.** It's really just the friendly voice —
  the actual decision about what to recommend is made by a separate, consistent set of rules
  behind the scenes, the same way every time, for every customer.
- **A customer is never shown something we can't actually deliver.** The real stock check (step 5)
  exists specifically so a recommendation that looked great on paper doesn't fall apart the moment
  someone tries to buy it.
- **Nothing becomes a real, sellable product until the customer explicitly says so** (Save or Add
  to Cart). Browsing, chatting, and previewing are always risk-free.

## Where the team can check all of this

Staff have their own dashboard (inside the Shopify Admin) where they can open any customer's
conversation and see every recommendation that was ever generated for them — not just the one the
customer ended up with — along with the real reasoning behind it: why it was picked, what the
stock check found, and how confident the system was and why. Nothing about this process is a
black box internally, even though the customer only ever sees the simple, friendly version of it.
